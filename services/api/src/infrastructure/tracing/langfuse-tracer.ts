import { LangfuseClient } from '@langfuse/client';
import { LangfuseSpanProcessor } from '@langfuse/otel';
import {
  LangfuseOtelSpanAttributes,
  setLangfuseTracerProvider,
  startObservation,
  type LangfuseObservation,
} from '@langfuse/tracing';
import { tracing } from '@opentelemetry/sdk-node';
import type { LlmUsage } from '../../domain/ports/llm.js';
import {
  NOOP_RUN_TRACE,
  type LlmCallRecord,
  type RunTrace,
  type RunTraceStart,
  type ToolCallRecord,
  type Tracer,
} from '../../domain/ports/tracer.js';

/**
 * Langfuse adapter of the `Tracer` port (Langfuse JS SDK v5, built on OpenTelemetry).
 *
 * Mapping: one trace per agent run (root observation of type `agent`, session = conversation),
 * one `generation` per LLM call with its model, token usage and the cost WE computed (so the
 * dashboards and the daily cap agree), one `tool` observation per tool call (level ERROR when it
 * failed), and numeric scores on the trace.
 *
 * The domain reports calls after the fact with explicit timings, so child observations are
 * created with explicit start/end times and an explicit parent: no OpenTelemetry context
 * propagation is needed, and spans live in an isolated tracer provider (nothing global).
 *
 * Tracing never changes the outcome of a run: every operation swallows its own errors and reports
 * them to `onError`.
 */

export const TRACE_NAME = 'agent-run';

/** Where scores go (`LangfuseClient.score` in production, a fake in tests). */
export interface ScoreSink {
  create(score: { traceId: string; name: string; value: number; comment?: string }): void;
  flush(): Promise<void>;
}

export interface LangfuseTracerOptions {
  readonly scores: ScoreSink;
  /** Exports buffered spans (the tracer provider's `forceFlush`). */
  readonly flushSpans: () => Promise<void>;
  readonly onError?: (error: unknown, operation: string) => void;
}

type ErrorHandler = (error: unknown, operation: string) => void;

const ignoreErrors: ErrorHandler = () => undefined;

function guard(onError: ErrorHandler, operation: string, action: () => void): void {
  try {
    action();
  } catch (error) {
    onError(error, operation);
  }
}

/** Langfuse's usage keys for Anthropic-style token counts. */
export function usageDetails(usage: LlmUsage): Record<string, number> {
  return {
    input: usage.inputTokens,
    output: usage.outputTokens,
    cache_read_input_tokens: usage.cacheReadTokens,
    cache_creation_input_tokens: usage.cacheWriteTokens,
  };
}

/**
 * Trace-level attributes, set on every observation of the run (not only the root): Langfuse
 * aggregations such as cost per session only include observations that carry them.
 */
function traceAttributes(start: RunTraceStart) {
  return {
    [LangfuseOtelSpanAttributes.TRACE_NAME]: TRACE_NAME,
    [LangfuseOtelSpanAttributes.TRACE_SESSION_ID]: start.conversationId,
    [LangfuseOtelSpanAttributes.TRACE_TAGS]: [...start.tags],
  };
}

function startRunTrace(start: RunTraceStart, options: LangfuseTracerOptions): RunTrace {
  const onError = options.onError ?? ignoreErrors;
  const attributes = traceAttributes(start);
  const root = startObservation(
    TRACE_NAME,
    {
      input: { userText: start.userText },
      metadata: { runId: start.runId, model: start.model },
    },
    { asType: 'agent' },
  );
  root.otelSpan.setAttributes(attributes);
  const parentSpanContext = root.otelSpan.spanContext();
  const traceId = root.traceId;

  const child = (observation: LangfuseObservation, endedAt: Date): void => {
    observation.otelSpan.setAttributes(attributes);
    observation.end(endedAt);
  };

  return {
    traceId,
    llmCall(record: LlmCallRecord) {
      guard(onError, 'llmCall', () => {
        const generation = startObservation(
          `llm-call-${record.step}`,
          {
            model: record.model,
            input: record.input,
            output: record.output,
            usageDetails: usageDetails(record.usage),
            costDetails: { total: record.costUsd },
            metadata: { step: record.step, stopReason: record.stopReason },
            ...(record.error === null
              ? {}
              : { level: 'ERROR' as const, statusMessage: record.error }),
          },
          { asType: 'generation', startTime: record.startedAt, parentSpanContext },
        );
        child(generation, record.endedAt);
      });
    },
    toolCall(record: ToolCallRecord) {
      guard(onError, 'toolCall', () => {
        const tool = startObservation(
          record.name,
          {
            input: record.input,
            output: record.output,
            metadata: { callId: record.callId, step: record.step },
            level: record.ok ? ('DEFAULT' as const) : ('ERROR' as const),
            ...(record.error === null ? {} : { statusMessage: record.error }),
          },
          { asType: 'tool', startTime: record.startedAt, parentSpanContext },
        );
        child(tool, record.endedAt);
      });
    },
    score(name, value, comment) {
      guard(onError, 'score', () => {
        options.scores.create({
          traceId,
          name,
          value,
          ...(comment === undefined ? {} : { comment }),
        });
      });
    },
    end(result) {
      guard(onError, 'end', () => {
        root.update({
          // The root observation's input/output are the trace's (Langfuse v5).
          output: result.output,
          metadata: {
            runId: start.runId,
            model: start.model,
            status: result.status,
            responseType: result.responseType,
            errorCode: result.errorCode,
            steps: result.steps,
            costUsd: result.costUsd,
            usage: usageDetails(result.usage),
          },
          ...(result.status === 'error'
            ? { level: 'ERROR' as const, statusMessage: result.errorCode ?? 'error' }
            : {}),
        });
        root.end();
      });
    },
  };
}

export function createLangfuseTracer(options: LangfuseTracerOptions): Tracer {
  const onError = options.onError ?? ignoreErrors;
  return {
    startRun(start) {
      try {
        return startRunTrace(start, options);
      } catch (error) {
        onError(error, 'startRun');
        return NOOP_RUN_TRACE;
      }
    },
    scoreTrace(traceId, name, value, comment) {
      guard(onError, 'scoreTrace', () => {
        options.scores.create({
          traceId,
          name,
          value,
          ...(comment === undefined ? {} : { comment }),
        });
      });
    },
    async flush() {
      const results = await Promise.allSettled([options.flushSpans(), options.scores.flush()]);
      for (const result of results) {
        if (result.status === 'rejected') onError(result.reason, 'flush');
      }
    },
  };
}

export interface LangfuseSettings {
  readonly publicKey: string;
  readonly secretKey: string;
  /** EU cloud by default (https://cloud.langfuse.com). */
  readonly baseUrl: string;
  /** Langfuse environment (lowercase, e.g. `production`). */
  readonly environment: string;
  readonly onError?: (error: unknown, operation: string) => void;
  /** Test seams: replace the OTLP exporter and the score client (no network). */
  readonly exporter?: tracing.SpanExporter;
  readonly scores?: ScoreSink & { shutdown?: () => Promise<void> };
}

export interface LangfuseTracing {
  readonly tracer: Tracer;
  /** Flushes buffered spans and scores, then releases the exporter (call once, on shutdown). */
  shutdown(): Promise<void>;
}

/**
 * Starts Langfuse tracing in an isolated OpenTelemetry tracer provider (no global registration,
 * no auto-instrumentation): only the spans this adapter creates are exported.
 */
export function startLangfuseTracing(settings: LangfuseSettings): LangfuseTracing {
  const processor = new LangfuseSpanProcessor({
    publicKey: settings.publicKey,
    secretKey: settings.secretKey,
    baseUrl: settings.baseUrl,
    environment: settings.environment,
    // Chat payloads never contain media; skip the base64 scan and upload.
    mediaUploadEnabled: false,
    ...(settings.exporter === undefined
      ? {}
      : { exporter: settings.exporter, exportMode: 'immediate' as const }),
  });
  const provider = new tracing.BasicTracerProvider({ spanProcessors: [processor] });
  setLangfuseTracerProvider(provider);

  const client =
    settings.scores ??
    new LangfuseClient({
      publicKey: settings.publicKey,
      secretKey: settings.secretKey,
      baseUrl: settings.baseUrl,
    }).score;

  const tracer = createLangfuseTracer({
    scores: client,
    flushSpans: () => provider.forceFlush(),
    ...(settings.onError === undefined ? {} : { onError: settings.onError }),
  });

  return {
    tracer,
    async shutdown() {
      await tracer.flush();
      await provider.shutdown();
      await client.shutdown?.();
      setLangfuseTracerProvider(null);
    },
  };
}
