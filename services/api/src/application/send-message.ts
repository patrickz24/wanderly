import type { AgentEvent, ConversationMessage, Usage } from '@wanderly/contracts';
import type {
  AgentLimits,
  AgentRunResult,
  AgentStepEvent,
  ModelPricing,
} from '../domain/agent/types.js';
import { BudgetExceededError, NotFoundError } from '../domain/errors.js';
import { costUsd } from '../domain/pricing.js';
import type { KnowledgeRepository, Retriever } from '../domain/ports/knowledge.js';
import type { LlmMessage, LlmPort } from '../domain/ports/llm.js';
import type { Clock, RunTrace, Tracer } from '../domain/ports/tracer.js';
import { toAssistantMessage } from './dto.js';
import { ConversationBusyError, TurnLimitReachedError } from './errors.js';
import type { RunAgent } from './ports/agent-runner.js';
import type { Conversation, ConversationRepository, NewMessage } from './ports/conversations.js';
import type { RunRecord, RunRepository, SpendLedger } from './ports/runs.js';
import { SILENT_LOGGER, type IdGenerator, type UseCaseLogger } from './ports/system.js';
import type { UnitOfWork } from './ports/unit-of-work.js';
import {
  citationsResolved,
  isBudgetExhausted,
  isoDate,
  meterLlm,
  titleFrom,
  utcDayBounds,
} from './run-accounting.js';

/** Plan §5.6: a conversation holds at most 12 user turns, so no compaction is needed. */
export const MAX_USER_TURNS = 12;

/** Score names attached to every run's trace (online checks). */
export const TRACE_SCORES = {
  validFirstTry: 'schema_valid_first_try',
  citationsOk: 'citations_ok',
  toolErrors: 'tool_errors',
} as const;

type AssistantMessage = Extract<ConversationMessage, { role: 'assistant' }>;

/** Everything the agent runtime needs besides the per-run trace, clock and event sink. */
export interface AgentRuntime {
  readonly runAgent: RunAgent;
  readonly llm: LlmPort;
  readonly retriever: Retriever;
  readonly knowledge: KnowledgeRepository;
  readonly limits: AgentLimits;
  readonly pricing: ModelPricing;
  /** Secret marker of the system prompt (leak detection), stable across restarts. */
  readonly canaryToken: string;
}

export interface SendMessageDeps {
  readonly conversations: ConversationRepository;
  readonly runs: RunRepository;
  readonly unitOfWork: UnitOfWork;
  readonly ledger: SpendLedger;
  readonly agent: AgentRuntime;
  readonly tracer: Tracer;
  readonly clock: Clock;
  readonly ids: IdGenerator;
  /** Global daily LLM spending cap (USD), shared by every caller. */
  readonly dailyBudgetUsd: number;
  readonly maxUserTurns?: number;
  /** Tags on every trace (e.g. `["api"]`, `["eval", "case:…"]`). */
  readonly traceTags?: readonly string[];
}

export interface SendMessageCommand {
  readonly sessionId: string;
  readonly conversationId: string;
  readonly text: string;
}

export interface SendMessageIo {
  /** Aborted when the client goes away: in-flight LLM calls are cancelled. */
  readonly signal: AbortSignal;
  /** Receives the run's events in order; must not throw (failures are logged and ignored). */
  readonly emit: (event: AgentEvent) => void;
  readonly log?: UseCaseLogger;
}

export interface SendMessageResult {
  readonly runId: string;
  readonly traceId: string | null;
  readonly message: AssistantMessage;
  readonly usage: Usage;
  readonly costUsd: number;
  readonly steps: number;
  readonly latencyMs: number;
}

export interface SendMessage {
  /**
   * Runs one agent turn. Throws before emitting any event when the turn cannot start
   * (`NotFoundError`, `ConversationBusyError`, `TurnLimitReachedError`, `BudgetExceededError`).
   * Once `run.started` is emitted the run is always recorded; a failed run then throws its
   * error (a domain error, or the unexpected one) after recording it.
   */
  execute(command: SendMessageCommand, io: SendMessageIo): Promise<SendMessageResult>;
}

export function createSendMessage(deps: SendMessageDeps): SendMessage {
  /** Conversations with a run in progress in this process (one run at a time each). */
  const inFlight = new Set<string>();

  return {
    async execute(command, io) {
      const conversation = await deps.conversations.findForSession(
        command.conversationId,
        command.sessionId,
      );
      if (conversation === null) throw new NotFoundError('conversation', command.conversationId);
      // No await between the check and the add: concurrent requests cannot both pass.
      if (inFlight.has(conversation.id)) throw new ConversationBusyError(conversation.id);
      inFlight.add(conversation.id);
      try {
        const startedAt = deps.clock.now();
        await assertTurnAllowed(deps, conversation.id, startedAt);
        return await runTurn(deps, conversation, command.text, io, startedAt);
      } finally {
        inFlight.delete(conversation.id);
      }
    },
  };
}

/** Pre-flight checks, all before any LLM call. */
async function assertTurnAllowed(
  deps: SendMessageDeps,
  conversationId: string,
  now: Date,
): Promise<void> {
  const maxTurns = deps.maxUserTurns ?? MAX_USER_TURNS;
  if ((await deps.conversations.countCompletedTurns(conversationId)) >= maxTurns) {
    throw new TurnLimitReachedError(conversationId, maxTurns);
  }
  const { from, to } = utcDayBounds(now);
  const spentUsd = await deps.ledger.spentUsd(from, to);
  if (isBudgetExhausted(spentUsd, deps.agent.limits.maxRunCostUsd, deps.dailyBudgetUsd)) {
    throw new BudgetExceededError(spentUsd, deps.dailyBudgetUsd);
  }
}

type RunOutcome =
  | { readonly kind: 'result'; readonly result: AgentRunResult }
  | { readonly kind: 'crash'; readonly error: unknown };

interface RunContext {
  readonly deps: SendMessageDeps;
  readonly conversation: Conversation;
  readonly text: string;
  readonly runId: string;
  readonly userMessageId: string;
  readonly trace: RunTrace;
  readonly startedAt: Date;
  readonly completedAt: Date;
  readonly cancelled: boolean;
  readonly log: UseCaseLogger;
}

async function runTurn(
  deps: SendMessageDeps,
  conversation: Conversation,
  text: string,
  io: SendMessageIo,
  startedAt: Date,
): Promise<SendMessageResult> {
  const { agent, clock, ids } = deps;
  const log = io.log ?? SILENT_LOGGER;
  const emit = (event: AgentEvent): void => {
    try {
      io.emit(event);
    } catch (error) {
      log.warn({ err: error, eventType: event.type }, 'failed to emit a run event');
    }
  };

  const history = await deps.conversations.loadHistory(conversation.id);
  const runId = ids.newId();
  const userMessageId = ids.newId();
  const trace = deps.tracer.startRun({
    runId,
    conversationId: conversation.id,
    model: agent.llm.model,
    userText: text,
    tags: deps.traceTags ?? [],
  });
  emit({ type: 'run.started', runId, conversationId: conversation.id, userMessageId });

  const metered = meterLlm(agent.llm, {
    signal: io.signal,
    costOf: (usage) => costUsd(usage, agent.pricing),
  });
  let outcome: RunOutcome;
  try {
    const result = await agent.runAgent(
      {
        runId,
        conversationId: conversation.id,
        history,
        userText: text,
        brief: conversation.brief,
        today: isoDate(startedAt),
      },
      {
        llm: metered.port,
        retriever: agent.retriever,
        knowledge: agent.knowledge,
        trace,
        clock,
        limits: agent.limits,
        pricing: agent.pricing,
        canaryToken: agent.canaryToken,
        signal: io.signal,
        onEvent: (event) => emit(toAgentEvent(runId, event)),
      },
    );
    outcome = { kind: 'result', result };
  } catch (error) {
    outcome = { kind: 'crash', error };
  }

  const context: RunContext = {
    deps,
    conversation,
    text,
    runId,
    userMessageId,
    trace,
    startedAt,
    completedAt: clock.now(),
    cancelled: io.signal.aborted,
    log,
  };

  if (outcome.kind === 'crash') {
    const record = crashedRunRecord(context, metered.usage(), metered.costUsd());
    closeTrace(trace, record, null);
    await saveFailedRun(context, record);
    throw outcome.error;
  }

  const { result } = outcome;
  logSignals(log, runId, result);
  if (result.status === 'error') {
    const record = failedRunRecord(context, result);
    closeTrace(trace, record, { error: record.errorCode });
    await saveFailedRun(context, record);
    throw result.error;
  }

  const messages = withIds(context, result.newMessages);
  const record = completedRunRecord(context, result, messages);
  closeTrace(trace, record, result.response);
  await commitTurn(context, record, messages);

  const message = toAssistantMessage({
    id: record.assistantMessageId ?? runId,
    runId,
    response: result.response,
    sources: result.sources,
    toolCalls: result.toolCalls,
    createdAt: context.completedAt,
  });
  const usage: Usage = { ...result.usage };
  emit({ type: 'response', runId, message });
  emit({
    type: 'run.finished',
    runId,
    steps: result.steps,
    usage,
    costUsd: result.costUsd,
    latencyMs: result.latencyMs,
    traceId: trace.traceId,
  });
  return {
    runId,
    traceId: trace.traceId,
    message,
    usage,
    costUsd: result.costUsd,
    steps: result.steps,
    latencyMs: result.latencyMs,
  };
}

/** Guardrail signals are logged for investigation; they never block on their own. */
function logSignals(log: UseCaseLogger, runId: string, result: AgentRunResult): void {
  const { canaryLeak, providerRefusal, injectionSignals } = result.signals;
  if (canaryLeak) log.error({ runId }, 'system prompt canary found in a model output');
  if (providerRefusal) log.warn({ runId }, 'the provider refused to answer');
  if (injectionSignals.length > 0) {
    log.warn({ runId, injectionSignals: [...injectionSignals] }, 'prompt injection signals');
  }
}

function toAgentEvent(runId: string, event: AgentStepEvent): AgentEvent {
  return event.type === 'tool.started'
    ? { type: 'tool.started', runId, callId: event.callId, name: event.name, input: event.input }
    : { type: 'tool.finished', runId, call: event.call };
}

/** The user turn keeps the id announced in `run.started`; every other message gets a new id. */
function withIds(context: RunContext, messages: readonly LlmMessage[]): NewMessage[] {
  const { llm } = context.deps.agent;
  return messages.map((message, index) => {
    const isAssistant = message.role === 'assistant';
    return {
      id: index === 0 ? context.userMessageId : context.deps.ids.newId(),
      message,
      provider: isAssistant ? llm.provider : null,
      model: isAssistant ? llm.model : null,
      createdAt: index === 0 ? context.startedAt : context.completedAt,
    };
  });
}

function baseRecord(context: RunContext) {
  return {
    id: context.runId,
    conversationId: context.conversation.id,
    traceId: context.trace.traceId,
    model: context.deps.agent.llm.model,
    userText: context.text,
    createdAt: context.completedAt,
  };
}

const elapsedMs = (context: RunContext): number =>
  Math.max(0, context.completedAt.getTime() - context.startedAt.getTime());

function completedRunRecord(
  context: RunContext,
  result: Extract<AgentRunResult, { status: 'ok' }>,
  messages: readonly NewMessage[],
): RunRecord {
  const assistant = messages.findLast((entry) => entry.message.role === 'assistant');
  return {
    ...baseRecord(context),
    status: 'ok',
    responseType: result.response.type,
    errorCode: null,
    failureReason: null,
    steps: result.steps,
    repairs: result.repairs,
    toolCallCount: result.toolCalls.length,
    toolErrorCount: result.toolCalls.filter((call) => !call.ok).length,
    usage: result.usage,
    costUsd: result.costUsd,
    latencyMs: result.latencyMs,
    validFirstTry: result.validFirstTry,
    citationsOk: citationsResolved(result.response, result.sources),
    userMessageId: context.userMessageId,
    assistantMessageId: assistant?.id ?? null,
    response: result.response,
    sources: result.sources,
    toolCalls: result.toolCalls,
  };
}

function failedRunRecord(
  context: RunContext,
  result: Extract<AgentRunResult, { status: 'error' }>,
): RunRecord {
  return {
    ...baseRecord(context),
    status: 'error',
    responseType: null,
    // Whatever the runtime reports, a run abandoned by its client was cancelled.
    errorCode: context.cancelled ? 'CANCELLED' : result.error.code,
    failureReason: context.cancelled ? 'cancelled' : result.reason,
    steps: result.steps,
    repairs: result.repairs,
    toolCallCount: result.toolCalls.length,
    toolErrorCount: result.toolCalls.filter((call) => !call.ok).length,
    usage: result.usage,
    costUsd: result.costUsd,
    latencyMs: result.latencyMs,
    validFirstTry: result.error.code === 'INVALID_OUTPUT' ? false : null,
    citationsOk: null,
    userMessageId: null,
    assistantMessageId: null,
    response: null,
    sources: [],
    toolCalls: result.toolCalls,
  };
}

/** The runtime threw (a bug): record what the metered LLM port observed. */
function crashedRunRecord(
  context: RunContext,
  usage: RunRecord['usage'],
  costUsd: number,
): RunRecord {
  return {
    ...baseRecord(context),
    status: 'error',
    responseType: null,
    errorCode: context.cancelled ? 'CANCELLED' : 'INTERNAL_ERROR',
    failureReason: context.cancelled ? 'cancelled' : 'crash',
    steps: 0,
    repairs: 0,
    toolCallCount: 0,
    toolErrorCount: 0,
    usage,
    costUsd,
    latencyMs: elapsedMs(context),
    validFirstTry: null,
    citationsOk: null,
    userMessageId: null,
    assistantMessageId: null,
    response: null,
    sources: [],
    toolCalls: [],
  };
}

/** Online scores and the end of the trace. Tracing never changes the outcome of a run. */
function closeTrace(trace: RunTrace, record: RunRecord, output: unknown): void {
  if (record.validFirstTry !== null) {
    trace.score(TRACE_SCORES.validFirstTry, record.validFirstTry ? 1 : 0);
  }
  if (record.citationsOk !== null) {
    trace.score(TRACE_SCORES.citationsOk, record.citationsOk ? 1 : 0);
  }
  trace.score(TRACE_SCORES.toolErrors, record.toolErrorCount);
  trace.end({
    status: record.status,
    responseType: record.responseType,
    errorCode: record.errorCode,
    output,
    usage: record.usage,
    costUsd: record.costUsd,
    steps: record.steps,
  });
}

/**
 * A completed turn is committed atomically: the new messages (append-only), the conversation's
 * brief and title, and the run. If that fails, the run is still recorded as failed so the daily
 * cap accounts for its cost, and the history stays as it was (a valid transcript).
 */
async function commitTurn(
  context: RunContext,
  record: RunRecord,
  messages: readonly NewMessage[],
): Promise<void> {
  const { conversation, deps } = context;
  try {
    await deps.unitOfWork.inTransaction(async ({ conversations, runs }) => {
      await conversations.appendMessages(conversation.id, messages);
      await conversations.updateAfterTurn(conversation.id, {
        brief: record.response?.brief ?? conversation.brief,
        titleIfUnset: titleFrom(context.text),
        updatedAt: context.completedAt,
      });
      await runs.save(record);
    });
  } catch (error) {
    await saveFailedRun(context, {
      ...record,
      status: 'error',
      responseType: null,
      errorCode: 'INTERNAL_ERROR',
      failureReason: 'persistence',
      citationsOk: null,
      userMessageId: null,
      assistantMessageId: null,
      response: null,
      sources: [],
    });
    throw error;
  }
}

/**
 * Failed runs are recorded without touching the history: a partial exchange (e.g. a tool call
 * without its result) would make the next request invalid, and the user can simply resend.
 * Recording problems are logged, never allowed to hide the run's own error.
 */
async function saveFailedRun(context: RunContext, record: RunRecord): Promise<void> {
  try {
    await context.deps.runs.save(record);
  } catch (error) {
    context.log.error(
      { err: error, runId: record.id, costUsd: record.costUsd },
      'failed to record a failed run',
    );
  }
}
