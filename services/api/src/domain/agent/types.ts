/**
 * Contract between the agent runtime (`runAgent`, domain) and the use case that drives it
 * (`SendMessage`, application). The use case loads the conversation, calls `runAgent`, appends
 * `newMessages` to the stored history (append-only) and persists the run.
 */
import type { AgentResponse, SourceSummary, ToolCallSummary, TripBrief } from '@wanderly/contracts';
import type { KnownDomainError } from '../errors.js';
import type { KnowledgeRepository, Retriever } from '../ports/knowledge.js';
import type { LlmMessage, LlmPort, LlmUsage } from '../ports/llm.js';
import type { Clock, RunTrace } from '../ports/tracer.js';

export interface AgentLimits {
  /** Maximum LLM calls in one run. */
  readonly maxSteps: number;
  /** Repair attempts after an invalid terminal tool call. */
  readonly maxRepairs: number;
  /** Deadline of one LLM call. */
  readonly llmTimeoutMs: number;
  /** Deadline of one tool execution. */
  readonly toolTimeoutMs: number;
  /** Deadline of the whole run (all steps). */
  readonly runDeadlineMs: number;
  /** `max_tokens` of each LLM call (reasoning + output). */
  readonly maxOutputTokens: number;
  /**
   * Hard ceiling on the run's cost: the loop does not start a call whose worst-case cost (whole
   * prompt at the cache-write rate + `maxOutputTokens` of output) could cross it.
   */
  readonly maxRunCostUsd: number;
}

export interface AgentRunInput {
  readonly runId: string;
  readonly conversationId: string;
  /** Stored history of the conversation (append-only, provider blocks included). */
  readonly history: readonly LlmMessage[];
  readonly userText: string;
  /** Brief carried over from the previous turn. */
  readonly brief: TripBrief;
  /** Today's date (YYYY-MM-DD) for the prompt; injected for deterministic tests. */
  readonly today: string;
}

/** Steps reported while the run progresses (forwarded to the client as SSE). */
export type AgentStepEvent =
  | {
      readonly type: 'tool.started';
      readonly callId: string;
      readonly name: string;
      readonly input: unknown;
    }
  | { readonly type: 'tool.finished'; readonly call: ToolCallSummary };

export interface AgentRunDeps {
  readonly llm: LlmPort;
  readonly retriever: Retriever;
  readonly knowledge: KnowledgeRepository;
  readonly trace: RunTrace;
  readonly clock: Clock;
  readonly limits: AgentLimits;
  /** Prices used to cost each LLM call (USD per million tokens). */
  readonly pricing: ModelPricing;
  readonly onEvent: (event: AgentStepEvent) => void;
  /**
   * Secret marker placed in the system prompt; finding it in a response means the prompt leaked.
   * Must be stable across restarts (it is part of the cached prompt prefix) and ≥ 16 characters.
   */
  readonly canaryToken: string;
  /**
   * Cancels the run (e.g. the client disconnected). On abort, `runAgent` rejects with the
   * signal's reason; nothing of the run should be persisted.
   */
  readonly signal?: AbortSignal;
}

/** USD per million tokens. */
export interface ModelRates {
  readonly inputPerMTok: number;
  readonly outputPerMTok: number;
  readonly cacheReadPerMTok: number;
  readonly cacheWritePerMTok: number;
}

export interface ModelPricing extends ModelRates {
  /** Rates billed instead when a prompt exceeds `thresholdTokens` (e.g. Haiku 5.5 above 100K). */
  readonly longContext?: { readonly thresholdTokens: number; readonly rates: ModelRates };
}

/** What the guardrails observed during the run (for traces and evals; never shown to users). */
export interface AgentRunSignals {
  /** The canary token appeared in a terminal output; that output was blocked. */
  readonly canaryLeak: boolean;
  /** The provider refused (safety classifiers); the response is a synthesized `decline`. */
  readonly providerRefusal: boolean;
  /** Prompt-injection heuristics that matched the user text or tool outputs (signals only). */
  readonly injectionSignals: readonly string[];
}

interface AgentRunCommon {
  /** Messages to append to the stored history, in order (user turn included). */
  readonly newMessages: readonly LlmMessage[];
  readonly toolCalls: readonly ToolCallSummary[];
  readonly usage: LlmUsage;
  readonly costUsd: number;
  /** LLM calls made. */
  readonly steps: number;
  /** Repairs used after invalid terminal calls. */
  readonly repairs: number;
  readonly latencyMs: number;
  readonly signals: AgentRunSignals;
}

/** Why a run failed, finer than the error code (agent_runs, eval error logs). */
export type AgentFailureReason =
  /** One LLM call exceeded `llmTimeoutMs` (LLM_TIMEOUT). */
  | 'llm_timeout'
  /** The run exceeded `runDeadlineMs` (LLM_TIMEOUT). */
  | 'run_deadline'
  /** 429 / 5xx / 529 / connection errors after the adapter's retries (PROVIDER_UNAVAILABLE). */
  | 'provider_unavailable'
  /** The model hit `max_tokens` (INVALID_OUTPUT). */
  | 'truncated'
  /** Terminal output still invalid after the repairs, or plain text after the reminder. */
  | 'invalid_output'
  /** `maxSteps` LLM calls without a valid terminal call (INVALID_OUTPUT). */
  | 'step_limit'
  /** The next call could have crossed `maxRunCostUsd` (INVALID_OUTPUT). */
  | 'cost_ceiling';

export type AgentRunResult =
  | (AgentRunCommon & {
      readonly status: 'ok';
      readonly response: AgentResponse;
      /** Evidence the response cites, resolved for display. */
      readonly sources: readonly SourceSummary[];
      /** True when the first terminal call was valid (no repair needed). */
      readonly validFirstTry: boolean;
    })
  | (AgentRunCommon & {
      readonly status: 'error';
      readonly error: KnownDomainError;
      readonly reason: AgentFailureReason;
    });
