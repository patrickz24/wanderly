/**
 * Observability port. The domain reports what happened (after the fact, with explicit timings);
 * the Langfuse adapter turns it into a trace, generations and spans. A no-op implementation is
 * used when tracing is not configured, so tracing never changes behaviour.
 */
import type { LlmUsage, StopReason } from './llm.js';

export interface RunTraceStart {
  readonly runId: string;
  /** Groups the runs of one conversation (Langfuse session). */
  readonly conversationId: string;
  readonly model: string;
  readonly userText: string;
  /** Free-form tags, e.g. ["eval", "case:ambiguous-03"]. */
  readonly tags: readonly string[];
}

export interface LlmCallRecord {
  readonly step: number;
  readonly model: string;
  readonly startedAt: Date;
  readonly endedAt: Date;
  readonly usage: LlmUsage;
  readonly costUsd: number;
  readonly stopReason: StopReason | null;
  /** Request messages and response content, serializable. */
  readonly input: unknown;
  readonly output: unknown;
  readonly error: string | null;
}

export interface ToolCallRecord {
  readonly step: number;
  readonly callId: string;
  readonly name: string;
  readonly startedAt: Date;
  readonly endedAt: Date;
  readonly input: unknown;
  readonly output: unknown;
  readonly ok: boolean;
  readonly error: string | null;
}

export interface RunTraceEnd {
  readonly status: 'ok' | 'error';
  readonly responseType: string | null;
  readonly errorCode: string | null;
  readonly output: unknown;
  readonly usage: LlmUsage;
  readonly costUsd: number;
  readonly steps: number;
}

export interface RunTrace {
  /** Null when tracing is disabled. */
  readonly traceId: string | null;
  llmCall(record: LlmCallRecord): void;
  toolCall(record: ToolCallRecord): void;
  /** Numeric score attached to the trace (online checks, user feedback). */
  score(name: string, value: number, comment?: string): void;
  end(result: RunTraceEnd): void;
}

export interface Tracer {
  startRun(start: RunTraceStart): RunTrace;
  /** Score a past trace (e.g. user feedback arriving later). */
  scoreTrace(traceId: string, name: string, value: number, comment?: string): void;
  /** Flush buffered events (call on shutdown and at the end of eval runs). */
  flush(): Promise<void>;
}

export const NOOP_RUN_TRACE: RunTrace = Object.freeze({
  traceId: null,
  llmCall: () => undefined,
  toolCall: () => undefined,
  score: () => undefined,
  end: () => undefined,
});

export const NOOP_TRACER: Tracer = Object.freeze({
  startRun: () => NOOP_RUN_TRACE,
  scoreTrace: () => undefined,
  flush: () => Promise.resolve(),
});

export interface Clock {
  now(): Date;
}

export const SYSTEM_CLOCK: Clock = Object.freeze({ now: () => new Date() });
