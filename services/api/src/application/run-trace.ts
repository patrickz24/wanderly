import type { AgentRunResult, AgentRunSignals } from '../domain/agent/types.js';
import type { RunTrace, RunTraceEnd } from '../domain/ports/tracer.js';
import { citationsResolved } from './run-accounting.js';

/**
 * Online scores attached to every run's trace, by the API (SendMessage) and by the agent
 * evaluation, so both can be filtered and compared on the same names in Langfuse.
 */
export const TRACE_SCORES = {
  /** 1 when the first terminal call passed validation; 0 after a repair or an invalid output. */
  validFirstTry: 'schema_valid_first_try',
  /** 1 when every cited reference resolves to a displayed source. */
  citationsOk: 'citations_ok',
  /** Failed data tool calls. */
  toolErrors: 'tool_errors',
  /** Repair rounds used after invalid terminal calls. */
  repairs: 'repairs',
  /** 1 when the canary appeared in a terminal output (the output was blocked). */
  canaryLeak: 'canary_leak',
  /** Distinct prompt-injection heuristics that matched; their names are in the comment. */
  injectionSignals: 'injection_signals',
  /** 1 when the provider refused (safety classifiers) and a decline was returned instead. */
  providerRefusal: 'provider_refusal',
} as const;

/** What the agent runtime reported; null when it threw instead of returning a result. */
export interface RuntimeReport {
  readonly repairs: number;
  readonly signals: AgentRunSignals;
}

/** Everything a trace is closed with: the end record and the inputs of the online scores. */
export interface RunTraceSummary extends RunTraceEnd {
  /** Null when unknown (the run failed before or outside output validation). */
  readonly validFirstTry: boolean | null;
  /** Null when the run produced no response. */
  readonly citationsOk: boolean | null;
  readonly toolErrorCount: number;
  readonly runtime: RuntimeReport | null;
}

/** First-try validity: known for a delivered response, false for an invalid output. */
export function validFirstTryOf(result: AgentRunResult): boolean | null {
  if (result.status === 'ok') return result.validFirstTry;
  return result.error.code === 'INVALID_OUTPUT' ? false : null;
}

const flag = (value: boolean): number => (value ? 1 : 0);

/**
 * Scores the run, then ends its trace. Scores whose input is unknown are left out rather than
 * guessed (a crashed run has no repairs or guardrail signals). Tracing never changes the outcome
 * of a run: the tracer adapters swallow their own errors.
 */
export function closeRunTrace(trace: RunTrace, summary: RunTraceSummary): void {
  if (summary.validFirstTry !== null) {
    trace.score(TRACE_SCORES.validFirstTry, flag(summary.validFirstTry));
  }
  if (summary.citationsOk !== null) {
    trace.score(TRACE_SCORES.citationsOk, flag(summary.citationsOk));
  }
  trace.score(TRACE_SCORES.toolErrors, summary.toolErrorCount);
  if (summary.runtime !== null) {
    const { repairs, signals } = summary.runtime;
    trace.score(TRACE_SCORES.repairs, repairs);
    trace.score(TRACE_SCORES.canaryLeak, flag(signals.canaryLeak));
    trace.score(TRACE_SCORES.providerRefusal, flag(signals.providerRefusal));
    const injection = [...new Set(signals.injectionSignals)].sort();
    if (injection.length === 0) trace.score(TRACE_SCORES.injectionSignals, 0);
    else trace.score(TRACE_SCORES.injectionSignals, injection.length, injection.join(', '));
  }
  trace.end({
    status: summary.status,
    responseType: summary.responseType,
    errorCode: summary.errorCode,
    output: summary.output,
    usage: summary.usage,
    costUsd: summary.costUsd,
    steps: summary.steps,
  });
}

/**
 * The trace summary of a runtime result, for callers that drive `runAgent` without recording a
 * run (the agent evaluation). SendMessage builds its summary from the recorded run instead, which
 * also knows about cancellations and persistence failures.
 */
export function traceSummaryOf(result: AgentRunResult): RunTraceSummary {
  const common = {
    usage: result.usage,
    costUsd: result.costUsd,
    steps: result.steps,
    validFirstTry: validFirstTryOf(result),
    toolErrorCount: result.toolCalls.filter((call) => !call.ok).length,
    runtime: { repairs: result.repairs, signals: result.signals },
  };
  if (result.status === 'ok') {
    return {
      ...common,
      status: 'ok',
      responseType: result.response.type,
      errorCode: null,
      output: result.response,
      citationsOk: citationsResolved(result.response, result.sources),
    };
  }
  return {
    ...common,
    status: 'error',
    responseType: null,
    errorCode: result.error.code,
    output: { error: result.error.code, reason: result.reason },
    citationsOk: null,
  };
}
