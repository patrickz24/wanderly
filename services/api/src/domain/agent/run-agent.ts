import type { AgentResponse, ToolCallSummary } from '@wanderly/contracts';
import {
  InvalidOutputError,
  type KnownDomainError,
  LlmTimeoutError,
  ProviderUnavailableError,
} from '../errors.js';
import { containsCanary } from '../guardrails/canary.js';
import { detectInjectionSignals } from '../guardrails/injection.js';
import { resolveSources } from '../guardrails/sources.js';
import { validateResponse } from '../guardrails/validate-response.js';
import type {
  LlmMessage,
  LlmRequest,
  LlmResponse,
  LlmUsage,
  ToolCallBlock,
  ToolResultBlock,
} from '../ports/llm.js';
import { addUsage, ZERO_USAGE } from '../ports/llm.js';
import { costUsd, maxCallCostUsd } from '../pricing.js';
import { EvidenceRegistry } from '../tools/evidence.js';
import { AGENT_TOOL_SPECS, findDataTool } from '../tools/registry.js';
import {
  findTerminalTool,
  isTerminalToolName,
  TERMINAL_TOOL_NAMES,
} from '../tools/terminal-tools.js';
import type { ToolResult } from '../tools/tool.js';
import { createCatalog, type DestinationCatalog } from './catalog.js';
import { DeadlineExceeded, startRunDeadline, withDeadline } from './deadline.js';
import {
  assistantMessage,
  pendingToolCalls,
  textBlock,
  toolCallsOf,
  toolResult,
  userMessage,
} from './messages.js';
import { buildSystemPrompt } from './system-prompt.js';
import type {
  AgentFailureReason,
  AgentRunDeps,
  AgentRunInput,
  AgentRunResult,
  AgentStepEvent,
} from './types.js';
import { buildUserTurn } from './user-turn.js';

/**
 * The agent loop (plan §5.2): call the model, run the tools it asks for, feed the results back,
 * until it calls a terminal tool whose output passes validation, or a limit stops the run.
 *
 * - The history is append-only: `input.history` is never modified, and every message of the run
 *   (user turn included) is returned in `newMessages`, ready to be appended to the store.
 * - Tool calls of one step run in parallel and all their results go back in ONE user message.
 *   Failures (unknown tool, invalid arguments, port error, timeout) become `is_error` results the
 *   model can recover from.
 * - A terminal call is validated (schema, business rules, grounding); an invalid one gets one
 *   repair round with the issues as an `is_error` result. Plain text gets one reminder.
 * - Limits: steps, per-call and per-tool timeouts, a run deadline, a per-run cost ceiling.
 * - Expected failures (timeouts, provider unavailable, invalid output, limits) are returned as
 *   `status: 'error'` with what was spent; unexpected errors (bugs, a rejected request, a failing
 *   catalog query) are thrown. Cancellation through `deps.signal` rejects with its reason.
 * - `deps.trace` receives one record per LLM call and tool call. The caller owns the trace: it
 *   attaches the scores (from `validFirstTry`, `repairs`, `toolCalls`, `signals`) and ends it.
 */
export async function runAgent(input: AgentRunInput, deps: AgentRunDeps): Promise<AgentRunResult> {
  const deadline = startRunDeadline(deps.limits.runDeadlineMs, deps.signal);
  try {
    return await new AgentRun(input, deps, deadline.signal).execute();
  } finally {
    deadline.dispose();
  }
}

/** Sent (as a user message) when the model replies in plain text instead of a terminal tool. */
export const NUDGE_TEXT = [
  'Reminder from the application: your last reply was plain text, which the user never sees.',
  `End this turn by calling exactly one terminal tool: ${TERMINAL_TOOL_NAMES.join(', ')}.`,
].join(' ');

const REFUSAL_MESSAGE =
  "I can't help with this request. I can help you plan a trip to one of the destinations I cover.";
const CANARY_MESSAGE =
  "I can't share that. I can help you plan a trip to one of the destinations I cover.";
const MAX_SUMMARY_CHARS = 300;

type CallOutcome =
  | { readonly ok: true; readonly response: LlmResponse }
  | { readonly ok: false; readonly result: AgentRunResult };

type TerminalVerdict =
  | { readonly ok: true; readonly response: AgentResponse }
  | { readonly ok: false; readonly issues: readonly string[] };

interface ToolExecution {
  readonly block: ToolResultBlock;
  readonly summary: ToolCallSummary;
}

class AgentRun {
  readonly #input: AgentRunInput;
  readonly #deps: AgentRunDeps;
  readonly #runSignal: AbortSignal;
  readonly #startedAt: Date;
  /** The whole conversation sent to the model: history + this run's messages. */
  readonly #messages: LlmMessage[];
  readonly #newMessages: LlmMessage[] = [];
  readonly #evidence = new EvidenceRegistry();
  readonly #toolCalls: ToolCallSummary[] = [];
  readonly #injectionSignals = new Set<string>();
  #usage: LlmUsage = ZERO_USAGE;
  #costUsd = 0;
  #steps = 0;
  #repairs = 0;
  #nudged = false;
  #canaryLeak = false;
  #providerRefusal = false;

  constructor(input: AgentRunInput, deps: AgentRunDeps, runSignal: AbortSignal) {
    this.#input = input;
    this.#deps = deps;
    this.#runSignal = runSignal;
    this.#startedAt = deps.clock.now();
    this.#messages = [...input.history];
  }

  async execute(): Promise<AgentRunResult> {
    const { limits } = this.#deps;
    const catalog = createCatalog(await this.#deps.knowledge.listDestinations());
    const base = {
      system: buildSystemPrompt(catalog, this.#deps.canaryToken),
      tools: AGENT_TOOL_SPECS,
      maxTokens: limits.maxOutputTokens,
    };
    const staticChars = base.system.length + JSON.stringify(base.tools).length;
    this.#append(buildUserTurn(this.#input));
    this.#recordSignals('user', this.#input.userText);

    while (this.#steps < limits.maxSteps) {
      this.#throwIfCancelled();
      if (this.#runSignal.aborted) {
        return this.#fail('run_deadline', new LlmTimeoutError(limits.runDeadlineMs));
      }
      const promptChars = staticChars + JSON.stringify(this.#messages).length;
      const nextCallMax = maxCallCostUsd(promptChars, limits.maxOutputTokens, this.#deps.pricing);
      if (this.#costUsd + nextCallMax > limits.maxRunCostUsd) {
        return this.#fail(
          'cost_ceiling',
          new InvalidOutputError([
            `Run cost ceiling reached: spent ${this.#costUsd.toFixed(6)} USD, the next call could cost up to ${nextCallMax.toFixed(6)} USD, ceiling ${limits.maxRunCostUsd} USD.`,
          ]),
        );
      }

      this.#steps += 1;
      const outcome = await this.#callModel(this.#steps, {
        ...base,
        messages: [...this.#messages],
      });
      if (!outcome.ok) return outcome.result;
      const { response } = outcome;

      // Refused or truncated output is not appended: it never becomes part of the conversation.
      if (response.stopReason === 'refusal') return this.#refused(catalog);
      if (response.stopReason === 'max_tokens') {
        return this.#fail(
          'truncated',
          new InvalidOutputError([
            `The model output was cut at max_tokens (${limits.maxOutputTokens}) before it was complete.`,
          ]),
        );
      }

      const assistant = assistantMessage(response.content);
      const calls = toolCallsOf(assistant);
      if (calls.length === 0) {
        if (assistant.content.some((block) => block.type === 'text')) this.#append(assistant);
        if (this.#nudged) {
          return this.#fail(
            'invalid_output',
            new InvalidOutputError([
              'The model answered in plain text again after a reminder to call a terminal tool.',
            ]),
          );
        }
        this.#nudged = true;
        this.#append(userMessage([textBlock(NUDGE_TEXT)]));
        continue;
      }

      this.#append(assistant);
      const terminalCalls = calls.filter((call) => isTerminalToolName(call.name));
      const [terminal] = terminalCalls;
      if (terminal === undefined) {
        this.#append(userMessage(await this.#executeTools(this.#steps, calls, catalog, new Map())));
        continue;
      }

      const verdict =
        terminalCalls.length > 1
          ? {
              ok: false as const,
              issues: [
                `Call exactly one terminal tool per turn; this message called ${terminalCalls.length}.`,
              ],
            }
          : this.#judge(terminal, catalog);
      if (verdict.ok) return this.#deliver(verdict.response, terminal, catalog);
      if (this.#repairs >= limits.maxRepairs) {
        return this.#fail('invalid_output', new InvalidOutputError(verdict.issues));
      }
      this.#repairs += 1;
      const overrides = new Map<string, ToolResultBlock>(
        terminalCalls.map((call) => [
          call.id,
          toolResult(
            call.id,
            call === terminal
              ? repairMessage(call.name, verdict.issues)
              : 'Ignored: call exactly one terminal tool per turn.',
            true,
          ),
        ]),
      );
      this.#append(userMessage(await this.#executeTools(this.#steps, calls, catalog, overrides)));
    }

    return this.#fail(
      'step_limit',
      new InvalidOutputError([
        `Step limit reached: ${limits.maxSteps} model calls without a valid terminal tool call.`,
      ]),
    );
  }

  // --- Model calls ------------------------------------------------------------------------------

  async #callModel(step: number, request: LlmRequest): Promise<CallOutcome> {
    const { llm, clock, trace, limits, pricing } = this.#deps;
    const startedAt = clock.now();
    const input = { messages: request.messages, tools: request.tools.map((tool) => tool.name) };
    try {
      const response = await withDeadline(
        (signal) => llm.generate(request, { signal }),
        limits.llmTimeoutMs,
        this.#runSignal,
      );
      const cost = costUsd(response.usage, pricing);
      this.#usage = addUsage(this.#usage, response.usage);
      this.#costUsd += cost;
      trace.llmCall({
        step,
        model: response.model,
        startedAt,
        endedAt: clock.now(),
        usage: response.usage,
        costUsd: cost,
        stopReason: response.stopReason,
        input,
        output: response.content,
        error: null,
      });
      return { ok: true, response };
    } catch (error) {
      trace.llmCall({
        step,
        model: llm.model,
        startedAt,
        endedAt: clock.now(),
        usage: ZERO_USAGE,
        costUsd: 0,
        stopReason: null,
        input,
        output: null,
        error: describe(error),
      });
      this.#throwIfCancelled();
      if (error instanceof DeadlineExceeded) {
        const reason = error.scope === 'run' ? 'run_deadline' : 'llm_timeout';
        return {
          ok: false,
          result: this.#fail(reason, new LlmTimeoutError(error.timeoutMs, { cause: error })),
        };
      }
      if (error instanceof LlmTimeoutError) {
        return { ok: false, result: this.#fail('llm_timeout', error) };
      }
      if (error instanceof ProviderUnavailableError) {
        return { ok: false, result: this.#fail('provider_unavailable', error) };
      }
      throw error;
    }
  }

  // --- Terminal calls ---------------------------------------------------------------------------

  #judge(call: ToolCallBlock, catalog: DestinationCatalog): TerminalVerdict {
    const tool = findTerminalTool(call.name);
    if (tool === undefined) return { ok: false, issues: [`Unknown terminal tool "${call.name}".`] };
    const parsed = tool.parse(call.input);
    if (!parsed.ok) return parsed;
    const issues = validateResponse(parsed.response, { evidence: this.#evidence, catalog });
    return issues.length === 0 ? { ok: true, response: parsed.response } : { ok: false, issues };
  }

  /**
   * Success. The terminal call stays open: the next turn's user message answers it (see
   * `buildUserTurn`). A response that leaks the canary is replaced by a decline, and its call is
   * closed here so the next turn does not report it as delivered.
   */
  #deliver(
    response: AgentResponse,
    terminal: ToolCallBlock,
    catalog: DestinationCatalog,
  ): AgentRunResult {
    if (containsCanary(response, this.#deps.canaryToken)) {
      this.#canaryLeak = true;
      this.#append(
        userMessage([
          toolResult(
            terminal.id,
            'Blocked by a safety check: this output revealed confidential instructions and was not shown to the user.',
            true,
          ),
        ]),
      );
      return this.#succeed(
        {
          type: 'decline',
          reason: 'unsafe',
          message: CANARY_MESSAGE,
          brief: this.#input.brief,
        },
        catalog,
      );
    }
    return this.#succeed(response, catalog);
  }

  /** The provider's safety classifiers declined: answer with a decline, keep the brief. */
  #refused(catalog: DestinationCatalog): AgentRunResult {
    this.#providerRefusal = true;
    return this.#succeed(
      { type: 'decline', reason: 'unsafe', message: REFUSAL_MESSAGE, brief: this.#input.brief },
      catalog,
    );
  }

  // --- Tools ------------------------------------------------------------------------------------

  async #executeTools(
    step: number,
    calls: readonly ToolCallBlock[],
    catalog: DestinationCatalog,
    overrides: ReadonlyMap<string, ToolResultBlock>,
  ): Promise<ToolResultBlock[]> {
    const executions = await Promise.all(
      calls.map(async (call): Promise<ToolExecution | ToolResultBlock> => {
        const override = overrides.get(call.id);
        return override ?? this.#executeTool(step, call, catalog);
      }),
    );
    return executions.map((execution) => {
      if ('summary' in execution) {
        this.#toolCalls.push(execution.summary);
        return execution.block;
      }
      return execution;
    });
  }

  async #executeTool(
    step: number,
    call: ToolCallBlock,
    catalog: DestinationCatalog,
  ): Promise<ToolExecution> {
    const { clock, trace, limits } = this.#deps;
    this.#emit({ type: 'tool.started', callId: call.id, name: call.name, input: call.input });
    const startedAt = clock.now();
    const evidence = new EvidenceRegistry();
    let result: ToolResult;
    let internalError: string | null = null;
    const tool = findDataTool(call.name);
    if (tool === undefined) {
      result = {
        ok: false,
        error: isTerminalToolName(call.name)
          ? 'Ignored: call exactly one terminal tool per turn.'
          : `Unknown tool "${call.name}". Use only the tools you were given.`,
      };
    } else {
      try {
        result = await withDeadline(
          () =>
            tool.run(call.input, {
              callId: call.id,
              retriever: this.#deps.retriever,
              knowledge: this.#deps.knowledge,
              catalog,
              evidence,
            }),
          limits.toolTimeoutMs,
          this.#runSignal,
        );
      } catch (error) {
        internalError = describe(error);
        result = { ok: false, error: toolFailureMessage(call.name, error, limits.toolTimeoutMs) };
      }
    }
    const endedAt = clock.now();
    if (result.ok) {
      // Only results the model actually receives become citable evidence.
      this.#evidence.merge(evidence);
      this.#recordSignals('tool', JSON.stringify(result.output));
    }
    trace.toolCall({
      step,
      callId: call.id,
      name: call.name,
      startedAt,
      endedAt,
      input: call.input,
      output: result.ok ? result.output : null,
      ok: result.ok,
      error: result.ok ? null : (internalError ?? result.error),
    });
    const summary: ToolCallSummary = {
      callId: call.id,
      name: call.name,
      input: call.input,
      ok: result.ok,
      durationMs: Math.max(0, endedAt.getTime() - startedAt.getTime()),
      summary: truncate(result.ok ? result.summary : result.error, MAX_SUMMARY_CHARS),
    };
    this.#emit({ type: 'tool.finished', call: summary });
    return {
      block: toolResult(
        call.id,
        result.ok ? JSON.stringify(result.output) : result.error,
        !result.ok,
      ),
      summary,
    };
  }

  // --- Run bookkeeping --------------------------------------------------------------------------

  #append(message: LlmMessage): void {
    this.#messages.push(message);
    this.#newMessages.push(message);
  }

  #recordSignals(source: 'user' | 'tool', text: string): void {
    for (const signal of detectInjectionSignals(text))
      this.#injectionSignals.add(`${source}:${signal}`);
  }

  #emit(event: AgentStepEvent): void {
    try {
      this.#deps.onEvent(event);
    } catch {
      // A failing listener (e.g. a closed SSE stream) must not break the run.
    }
  }

  #throwIfCancelled(): void {
    const cancel = this.#deps.signal;
    if (cancel?.aborted === true) throw cancel.reason;
  }

  #succeed(response: AgentResponse, catalog: DestinationCatalog): AgentRunResult {
    const common = this.#finish();
    return {
      ...common,
      status: 'ok',
      response,
      sources: resolveSources(response, this.#evidence, catalog),
      validFirstTry: this.#repairs === 0,
    };
  }

  /** Failure. Calls left open by the last assistant message are closed so the history stays valid. */
  #fail(reason: AgentFailureReason, error: KnownDomainError): AgentRunResult {
    const open = pendingToolCalls(this.#messages);
    if (open.length > 0) {
      this.#append(
        userMessage(
          open.map((call) =>
            toolResult(
              call.id,
              `Not delivered: the run stopped (${reason}) and the user saw an error message instead.`,
              true,
            ),
          ),
        ),
      );
    }
    return { ...this.#finish(), status: 'error', error, reason };
  }

  #finish() {
    const { clock } = this.#deps;
    return {
      newMessages: Object.freeze([...this.#newMessages]),
      toolCalls: Object.freeze([...this.#toolCalls]),
      usage: this.#usage,
      costUsd: this.#costUsd,
      steps: this.#steps,
      repairs: this.#repairs,
      latencyMs: Math.max(0, clock.now().getTime() - this.#startedAt.getTime()),
      signals: {
        canaryLeak: this.#canaryLeak,
        providerRefusal: this.#providerRefusal,
        injectionSignals: [...this.#injectionSignals],
      },
    };
  }
}

export function repairMessage(toolName: string, issues: readonly string[]): string {
  return [
    `Your ${toolName} call was rejected and NOT shown to the user. Fix every issue below, then call a terminal tool again:`,
    ...issues.map((issue) => `- ${issue}`),
  ].join('\n');
}

function toolFailureMessage(name: string, error: unknown, toolTimeoutMs: number): string {
  if (error instanceof DeadlineExceeded) {
    return error.scope === 'call'
      ? `${name} timed out after ${toolTimeoutMs} ms. Retry once, or continue without it.`
      : `${name} was stopped: the turn ran out of time.`;
  }
  // Internal details go to the trace, not to the model (it could repeat them to the user).
  return `${name} failed with an internal error. Retry once, or continue without it and say what is missing.`;
}

function describe(error: unknown): string {
  if (error instanceof Error) return `${error.name}: ${error.message}`;
  return String(error);
}

function truncate(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, max - 1)}…`;
}
