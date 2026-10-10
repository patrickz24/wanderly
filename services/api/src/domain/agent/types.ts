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
  /** Hard ceiling on the run's cost; the loop stops before exceeding it. */
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
}

export interface ModelPricing {
  readonly inputPerMTok: number;
  readonly outputPerMTok: number;
  readonly cacheReadPerMTok: number;
  readonly cacheWritePerMTok: number;
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
}

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
    });
