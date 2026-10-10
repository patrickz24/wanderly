import type {
  AgentResponse,
  AgentResponseType,
  ApiErrorCode,
  SourceSummary,
  ToolCallSummary,
} from '@wanderly/contracts';
import type { LlmUsage } from '../../domain/ports/llm.js';

/** Public error codes, plus CANCELLED for runs abandoned by a disconnected client. */
export type RunErrorCode = ApiErrorCode | 'CANCELLED';

/** One agent run, as recorded for accounting, observability and display. */
export interface RunRecord {
  readonly id: string;
  readonly conversationId: string;
  readonly traceId: string | null;
  readonly model: string;
  readonly status: 'ok' | 'error';
  readonly responseType: AgentResponseType | null;
  readonly errorCode: RunErrorCode | null;
  /**
   * Finer cause of a failure: the runtime's reason (e.g. `run_deadline`, `step_limit`), or
   * `cancelled`, `crash` or `persistence` for failures outside the runtime.
   */
  readonly failureReason: string | null;
  /** LLM calls made. */
  readonly steps: number;
  readonly repairs: number;
  readonly toolCallCount: number;
  readonly toolErrorCount: number;
  readonly usage: LlmUsage;
  readonly costUsd: number;
  readonly latencyMs: number;
  /** Null when unknown (the run failed before or outside output validation). */
  readonly validFirstTry: boolean | null;
  /** Null when the run produced no response. */
  readonly citationsOk: boolean | null;
  readonly userText: string;
  /** Set when the turn was appended to the history (successful runs only). */
  readonly userMessageId: string | null;
  readonly assistantMessageId: string | null;
  readonly response: AgentResponse | null;
  readonly sources: readonly SourceSummary[];
  readonly toolCalls: readonly ToolCallSummary[];
  readonly createdAt: Date;
}

/** What a session may know about one of its runs. */
export interface VisibleRun {
  readonly id: string;
  readonly traceId: string | null;
}

export interface RunRepository {
  save(run: RunRecord): Promise<void>;
  /** Null when the run does not exist or belongs to a conversation of another session. */
  findForSession(runId: string, sessionId: string): Promise<VisibleRun | null>;
}

/** Global LLM spending, derived from the recorded runs (shared by every API instance). */
export interface SpendLedger {
  /** USD spent by runs created in `[from, to)`. */
  spentUsd(from: Date, to: Date): Promise<number>;
}

export interface Feedback {
  readonly runId: string;
  readonly rating: 1 | -1;
  readonly comment: string | null;
  readonly createdAt: Date;
}

export interface FeedbackRepository {
  /** One rating per run: a new rating replaces the previous one. */
  upsert(feedback: Feedback): Promise<void>;
}
