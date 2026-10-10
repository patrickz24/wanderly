import type { AgentResponse, SourceRef, SourceSummary } from '@wanderly/contracts';
import { addUsage, ZERO_USAGE, type LlmPort, type LlmUsage } from '../domain/ports/llm.js';

/** Pure helpers for cost control and run bookkeeping. */

const MS_PER_DAY = 86_400_000;

/** The UTC calendar day containing `now`, as a half-open interval `[from, to)`. */
export function utcDayBounds(now: Date): { readonly from: Date; readonly to: Date } {
  const from = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
  return { from, to: new Date(from.getTime() + MS_PER_DAY) };
}

/** `YYYY-MM-DD` of `now` in UTC. */
export function isoDate(now: Date): string {
  return now.toISOString().slice(0, 10);
}

/**
 * A new run may start only if it cannot push the day's spending past the cap: the per-run cost
 * ceiling is reserved up front. A cap of 0 therefore disables every LLM call (kill switch).
 */
export function isBudgetExhausted(spentUsd: number, reserveUsd: number, limitUsd: number): boolean {
  return spentUsd + reserveUsd > limitUsd;
}

/** References a response cites as evidence (itinerary items and answers). */
export function citedRefs(response: AgentResponse): SourceRef[] {
  switch (response.type) {
    case 'itinerary':
      return response.itinerary.days.flatMap((day) => day.items.flatMap((item) => item.sourceRefs));
    case 'answer':
      return [...response.sourceRefs];
    case 'clarification':
    case 'decline':
      return [];
  }
}

/**
 * Online check: every reference the response cites resolves to a source shown to the user.
 * Vacuously true for responses that cite nothing (clarifications, declines).
 */
export function citationsResolved(
  response: AgentResponse,
  sources: readonly SourceSummary[],
): boolean {
  const shown = new Set(sources.map((source) => `${source.kind}:${source.id}`));
  return citedRefs(response).every((ref) => shown.has(`${ref.kind}:${ref.id}`));
}

export const MAX_TITLE_LENGTH = 80;

/** Conversation title derived from the first user message: one line, at most 80 characters. */
export function titleFrom(text: string): string {
  const line = text.replace(/\s+/g, ' ').trim();
  return line.length <= MAX_TITLE_LENGTH
    ? line
    : `${line.slice(0, MAX_TITLE_LENGTH - 1).trimEnd()}…`;
}

export interface MeteredLlm {
  /** Pass this port to the agent: same behaviour, plus cancellation and metering. */
  readonly port: LlmPort;
  /** Usage of every call that returned, whatever happens to the run afterwards. */
  usage(): LlmUsage;
  costUsd(): number;
}

/**
 * Wraps the LLM port for one run so that (1) every call is also aborted when `signal` aborts
 * (the client disconnected) and (2) the spend is known even if the run crashes before returning
 * its own accounting: the daily cap must never miss money actually spent.
 */
export function meterLlm(
  llm: LlmPort,
  {
    signal,
    costOf,
  }: { readonly signal: AbortSignal; readonly costOf: (usage: LlmUsage) => number },
): MeteredLlm {
  let usage = ZERO_USAGE;
  let costUsd = 0;
  return {
    port: {
      provider: llm.provider,
      model: llm.model,
      async generate(request, options) {
        const response = await llm.generate(request, {
          ...options,
          signal: AbortSignal.any([options.signal, signal]),
        });
        usage = addUsage(usage, response.usage);
        // Per call: rates may depend on each call's prompt size.
        costUsd += costOf(response.usage);
        return response;
      },
    },
    usage: () => usage,
    costUsd: () => costUsd,
  };
}
