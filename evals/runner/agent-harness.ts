import { EMPTY_TRIP_BRIEF, type AgentResponse, type TripBrief } from '@wanderly/contracts';
import { runAgent } from '../../services/api/src/domain/agent/run-agent.js';
import type {
  AgentLimits,
  AgentRunResult,
  ModelPricing,
} from '../../services/api/src/domain/agent/types.js';
import type {
  KnowledgeRepository,
  Retriever,
} from '../../services/api/src/domain/ports/knowledge.js';
import {
  addUsage,
  ZERO_USAGE,
  type LlmMessage,
  type LlmPort,
  type LlmUsage,
  type StopReason,
} from '../../services/api/src/domain/ports/llm.js';
import { SYSTEM_CLOCK, type RunTrace } from '../../services/api/src/domain/ports/tracer.js';
import type { RunObservation, RunStatus } from '../scorers/agent-metrics.js';
import type { AgentCase } from './agent-dataset.js';
import { assertServedModel, poisonRetriever, ServedModelMismatchError } from './agent-wrappers.js';

/**
 * Runs one (case, rep) through the production agent loop (`runAgent`, the entry point of the
 * SendMessage use case) with fresh ports, a hard wall-clock ceiling, and bounded retries of
 * infrastructure failures. Turns of a multi-turn case run in one conversation: the history and
 * the brief carry over exactly as SendMessage stores them.
 *
 * An attempt either produced an outcome to score (`scored`, even when the model failed) or it
 * failed for infrastructure reasons (`infra`): those go to errors.jsonl, never into the scores.
 */

/** Ports of one attempt, built fresh for each (case, rep, attempt): no state is shared. */
export interface AttemptPorts {
  readonly llm: LlmPort;
  readonly retriever: Retriever;
  readonly knowledge: KnowledgeRepository;
  readonly pricing: ModelPricing;
  readonly limits: AgentLimits;
  readonly canaryToken: string;
}

export type PortsFactory = (testCase: AgentCase, rep: number) => Promise<AttemptPorts>;

export const INFRA_FAILURES = [
  'provider_unavailable',
  'llm_timeout',
  'run_deadline',
  'case_timeout',
  'served_model_mismatch',
  'crash',
] as const;
export type InfraFailure = (typeof INFRA_FAILURES)[number];

/** Transient failures worth another attempt; the others fail loudly at once. */
const RETRYABLE: ReadonlySet<InfraFailure> = new Set([
  'provider_unavailable',
  'llm_timeout',
  'run_deadline',
]);

export interface LlmCallLog {
  readonly turn: number;
  readonly step: number;
  readonly model: string;
  readonly durationMs: number;
  readonly usage: LlmUsage;
  readonly costUsd: number;
  readonly stopReason: StopReason | null;
  readonly error: string | null;
}

export interface ToolCallLog {
  readonly turn: number;
  readonly step: number;
  readonly name: string;
  readonly durationMs: number;
  readonly ok: boolean;
  readonly error: string | null;
}

export interface TurnLog {
  readonly userText: string;
  readonly status: AgentRunResult['status'];
  readonly failureReason: string | null;
  readonly response: AgentResponse | null;
  /** Messages appended by this turn (user turn, assistant calls, tool results). */
  readonly messages: readonly LlmMessage[];
  readonly steps: number;
  readonly repairs: number;
  readonly latencyMs: number;
  readonly costUsd: number;
  readonly signals: unknown;
}

export interface CaseOutcome {
  readonly observation: RunObservation;
  readonly turns: readonly TurnLog[];
  readonly llmCalls: readonly LlmCallLog[];
  readonly toolCalls: readonly ToolCallLog[];
  readonly steps: number;
  readonly usage: LlmUsage;
  readonly costUsd: number;
  /** Sum of the runtime's run latencies over the turns of this (successful) attempt. */
  readonly latencyMs: number;
  /** Canary of this attempt's system prompt (to look for leaks). */
  readonly canaryToken: string;
}

export type AttemptResult =
  | { readonly kind: 'scored'; readonly outcome: CaseOutcome; readonly spentUsd: number }
  | {
      readonly kind: 'infra';
      readonly failure: InfraFailure;
      readonly message: string;
      readonly spentUsd: number;
    };

export class CaseTimeoutError extends Error {
  constructor(readonly ceilingMs: number) {
    super(`Case exceeded its wall-clock ceiling of ${ceilingMs} ms`);
    this.name = 'CaseTimeoutError';
  }
}

const INFRA_REASONS: ReadonlyMap<string, InfraFailure> = new Map([
  ['provider_unavailable', 'provider_unavailable'],
  ['llm_timeout', 'llm_timeout'],
  ['run_deadline', 'run_deadline'],
]);

export interface AttemptOptions {
  readonly today: string;
  readonly ceilingMs: number;
}

/** One attempt of one (case, rep). Never throws: every failure is classified. */
export async function runAttempt(
  testCase: AgentCase,
  ports: AttemptPorts,
  options: AttemptOptions,
): Promise<AttemptResult> {
  const controller = new AbortController();
  const recorder = new CallRecorder();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const ceiling = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      const error = new CaseTimeoutError(options.ceilingMs);
      controller.abort(error);
      reject(error);
    }, options.ceilingMs);
  });
  try {
    return await Promise.race([
      runTurns(testCase, ports, options, controller.signal, recorder),
      ceiling,
    ]);
  } catch (error) {
    return { kind: 'infra', ...classify(error), spentUsd: recorder.spentUsd };
  } finally {
    clearTimeout(timer);
  }
}

function classify(error: unknown): { failure: InfraFailure; message: string } {
  if (error instanceof CaseTimeoutError) return { failure: 'case_timeout', message: error.message };
  if (error instanceof ServedModelMismatchError) {
    return { failure: 'served_model_mismatch', message: error.message };
  }
  return {
    failure: 'crash',
    message: error instanceof Error ? `${error.name}: ${error.message}` : String(error),
  };
}

async function runTurns(
  testCase: AgentCase,
  ports: AttemptPorts,
  options: AttemptOptions,
  signal: AbortSignal,
  recorder: CallRecorder,
): Promise<AttemptResult> {
  const llm = assertServedModel(ports.llm);
  const retriever =
    testCase.poison === undefined
      ? ports.retriever
      : poisonRetriever(ports.retriever, testCase.poison, testCase.id);
  let history: readonly LlmMessage[] = [];
  let brief: TripBrief = EMPTY_TRIP_BRIEF;
  const turns: TurnLog[] = [];
  let last: AgentRunResult | undefined;

  for (const [index, userText] of testCase.turns.entries()) {
    recorder.turn = index + 1;
    const result = await runAgent(
      {
        runId: `${testCase.id}-turn-${index + 1}`,
        conversationId: testCase.id,
        history,
        userText,
        brief,
        today: options.today,
      },
      {
        llm,
        retriever,
        knowledge: ports.knowledge,
        trace: recorder.trace(),
        clock: SYSTEM_CLOCK,
        limits: ports.limits,
        pricing: ports.pricing,
        onEvent: () => undefined,
        canaryToken: ports.canaryToken,
        signal,
      },
    );
    turns.push(turnLog(userText, result));
    last = result;
    if (result.status === 'error') {
      const infra = INFRA_REASONS.get(result.reason);
      if (infra !== undefined) {
        return {
          kind: 'infra',
          failure: infra,
          message: result.error.message,
          spentUsd: recorder.spentUsd,
        };
      }
      break;
    }
    history = [...history, ...result.newMessages];
    brief = result.response.brief;
  }
  if (last === undefined) throw new Error(`Case ${testCase.id} has no turn`);

  const finalTurnIndex = turns.length - 1;
  const stoppedEarly = finalTurnIndex < testCase.turns.length - 1;
  const observation: RunObservation = {
    status: statusOf(last),
    failureReason:
      last.status === 'error'
        ? stoppedEarly
          ? `turn ${finalTurnIndex + 1}: ${last.reason}`
          : last.reason
        : null,
    response: last.status === 'ok' && !stoppedEarly ? last.response : null,
    lastTurn: last.newMessages,
    allTurns: turns.flatMap((turn) => turn.messages),
    validFirstTry: last.status === 'ok' ? last.validFirstTry : null,
  };
  const outcome: CaseOutcome = {
    observation,
    turns,
    llmCalls: recorder.llmCalls,
    toolCalls: recorder.toolCalls,
    steps: turns.reduce((sum, turn) => sum + turn.steps, 0),
    usage: recorder.llmCalls.reduce((sum, logged) => addUsage(sum, logged.usage), ZERO_USAGE),
    costUsd: recorder.spentUsd,
    latencyMs: turns.reduce((sum, turn) => sum + turn.latencyMs, 0),
    canaryToken: ports.canaryToken,
  };
  return { kind: 'scored', outcome, spentUsd: recorder.spentUsd };
}

function statusOf(result: AgentRunResult): RunStatus {
  if (result.status === 'ok') return result.signals.providerRefusal ? 'refusal' : 'ok';
  return result.reason === 'truncated' ? 'truncated' : 'model_error';
}

function turnLog(userText: string, result: AgentRunResult): TurnLog {
  return {
    userText,
    status: result.status,
    failureReason: result.status === 'error' ? result.reason : null,
    response: result.status === 'ok' ? result.response : null,
    messages: result.newMessages,
    steps: result.steps,
    repairs: result.repairs,
    latencyMs: result.latencyMs,
    costUsd: result.costUsd,
    signals: result.signals,
  };
}

/** Collects per-call records from the runtime's trace port (tokens, cost, timing, served model). */
class CallRecorder {
  turn = 1;
  readonly llmCalls: LlmCallLog[] = [];
  readonly toolCalls: ToolCallLog[] = [];

  get spentUsd(): number {
    return this.llmCalls.reduce((sum, logged) => sum + logged.costUsd, 0);
  }

  trace(): RunTrace {
    return {
      traceId: null,
      llmCall: (record) =>
        this.llmCalls.push({
          turn: this.turn,
          step: record.step,
          model: record.model,
          durationMs: record.endedAt.getTime() - record.startedAt.getTime(),
          usage: record.usage,
          costUsd: record.costUsd,
          stopReason: record.stopReason,
          error: record.error,
        }),
      toolCall: (record) =>
        this.toolCalls.push({
          turn: this.turn,
          step: record.step,
          name: record.name,
          durationMs: record.endedAt.getTime() - record.startedAt.getTime(),
          ok: record.ok,
          error: record.error,
        }),
      score: () => undefined,
      end: () => undefined,
    };
  }
}

// --- Retries ----------------------------------------------------------------------------------------

export interface RetryPolicy {
  readonly maxAttempts: number;
  readonly baseDelayMs: number;
  readonly maxDelayMs: number;
  readonly random: () => number;
  readonly sleep: (ms: number) => Promise<void>;
}

export const DEFAULT_RETRY_POLICY: RetryPolicy = {
  maxAttempts: 3,
  baseDelayMs: 2_000,
  maxDelayMs: 30_000,
  random: Math.random,
  sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
};

/** Full-jitter exponential backoff: a uniform delay in [0, min(max, base × 2^(attempt-1))]. */
export function backoffDelay(attempt: number, policy: RetryPolicy): number {
  const cap = Math.min(policy.maxDelayMs, policy.baseDelayMs * 2 ** (attempt - 1));
  return Math.floor(policy.random() * cap);
}

export interface RetriedResult {
  readonly final: AttemptResult;
  readonly attempts: number;
  /** Every failed attempt, retried or not (they all go to errors.jsonl). */
  readonly failures: readonly Extract<AttemptResult, { kind: 'infra' }>[];
  /** Spent over all attempts, failed ones included. */
  readonly spentUsd: number;
}

/**
 * Re-runs an attempt (with fresh ports) after a retryable infrastructure failure. A scored outcome
 * is never retried: a model failure is a result, not noise to reroll.
 */
export async function withRetries(
  attempt: () => Promise<AttemptResult>,
  policy: RetryPolicy = DEFAULT_RETRY_POLICY,
): Promise<RetriedResult> {
  const failures: Extract<AttemptResult, { kind: 'infra' }>[] = [];
  let spentUsd = 0;
  for (let index = 1; ; index++) {
    const result = await attempt();
    spentUsd += result.spentUsd;
    if (result.kind === 'scored') return { final: result, attempts: index, failures, spentUsd };
    failures.push(result);
    if (!RETRYABLE.has(result.failure) || index >= policy.maxAttempts) {
      return { final: result, attempts: index, failures, spentUsd };
    }
    await policy.sleep(backoffDelay(index, policy));
  }
}

/** What the data tools returned in the last turn (excerpts, POIs, weather, budget): the judge's context. */
export function retrievedContext(turns: readonly Pick<TurnLog, 'messages'>[]): string[] {
  const last = turns.at(-1);
  if (last === undefined) return [];
  return last.messages.flatMap((message) =>
    message.role === 'user'
      ? message.content.flatMap((block) =>
          block.type === 'tool_result' && !block.isError ? [block.content] : [],
        )
      : [],
  );
}
