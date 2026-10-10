import { readFile } from 'node:fs/promises';
import { z } from 'zod';
import type { RunSummary } from '../scorers/agent-summary.js';

/**
 * The CI gate of the agent evaluation (`evals/thresholds.json`).
 *
 * - Hard gates: near-deterministic invariants (schema valid after repair, no canary leak,
 *   citation integrity, enough attempts scored). Any violation fails.
 * - Soft gates: quality metrics, threshold = measured baseline minus a margin from its noise
 *   floor. A soft gate that is still `null` ("pending first baseline") is reported as pending: it
 *   neither passes nor fails, and the report says so.
 * - Harness checks: what the keyless control runs (oracle, null baselines) must score, proving the
 *   scorers are wired before any paid run.
 */

const BoundSchema = z
  .strictObject({
    min: z.number().optional(),
    max: z.number().optional(),
    baseline: z.number().optional(),
    margin: z.number().optional(),
    source: z.string().optional(),
  })
  .refine((bound) => bound.min !== undefined || bound.max !== undefined, 'min or max required');
type Bound = z.infer<typeof BoundSchema>;

const LimitsSchema = z.strictObject({
  min: z.record(z.string(), z.number()).optional(),
  max: z.record(z.string(), z.number()).optional(),
});

export const ThresholdsSchema = z.strictObject({
  version: z.literal(1),
  description: z.string(),
  hard: z.record(z.string(), BoundSchema),
  soft: z.strictObject({
    status: z.string(),
    metrics: z.record(z.string(), BoundSchema.nullable()),
  }),
  harnessCheck: z.record(z.string(), LimitsSchema),
});
export type Thresholds = z.infer<typeof ThresholdsSchema>;

export async function loadThresholds(file: string): Promise<Thresholds> {
  return ThresholdsSchema.parse(JSON.parse(await readFile(file, 'utf8')));
}

export type CheckOutcome = 'pass' | 'fail' | 'pending' | 'not_applicable';

export interface GateCheck {
  readonly kind: 'hard' | 'soft' | 'harness';
  readonly metric: string;
  readonly threshold: string;
  readonly actual: number | null;
  readonly outcome: CheckOutcome;
}

export interface GateResult {
  readonly verdict: 'pass' | 'fail';
  readonly checks: readonly GateCheck[];
  readonly pendingSoftGates: number;
}

/** Extra run-level values the gates can refer to (beyond the metric means). */
export interface RunFacts {
  /** Scored (case, rep) / all (case, rep) attempted, infra failures included. */
  readonly scoredFraction: number;
}

function actualOf(metric: string, summary: RunSummary, facts: RunFacts): number | null {
  if (metric === 'scored_fraction') return facts.scoredFraction;
  return summary.metrics[metric]?.mean ?? null;
}

function check(
  kind: GateCheck['kind'],
  metric: string,
  bound: Bound,
  actual: number | null,
): GateCheck {
  const parts = [
    ...(bound.min === undefined ? [] : [`>= ${bound.min}`]),
    ...(bound.max === undefined ? [] : [`<= ${bound.max}`]),
  ];
  if (actual === null) {
    return { kind, metric, threshold: parts.join(' and '), actual, outcome: 'not_applicable' };
  }
  const ok =
    (bound.min === undefined || actual >= bound.min - 1e-9) &&
    (bound.max === undefined || actual <= bound.max + 1e-9);
  return { kind, metric, threshold: parts.join(' and '), actual, outcome: ok ? 'pass' : 'fail' };
}

export function evaluateGate(
  summary: RunSummary,
  thresholds: Thresholds,
  facts: RunFacts,
): GateResult {
  const checks: GateCheck[] = [];
  for (const [metric, bound] of Object.entries(thresholds.hard)) {
    checks.push(check('hard', metric, bound, actualOf(metric, summary, facts)));
  }
  for (const [metric, bound] of Object.entries(thresholds.soft.metrics)) {
    const actual = actualOf(metric, summary, facts);
    if (bound === null) {
      checks.push({
        kind: 'soft',
        metric,
        threshold: thresholds.soft.status,
        actual,
        outcome: 'pending',
      });
    } else {
      checks.push(check('soft', metric, bound, actual));
    }
  }
  return {
    verdict: checks.some((item) => item.outcome === 'fail') ? 'fail' : 'pass',
    checks,
    pendingSoftGates: checks.filter((item) => item.outcome === 'pending').length,
  };
}

/** Checks a control run (oracle, null baselines) against what it must score. */
export function evaluateHarnessCheck(
  summary: RunSummary,
  thresholds: Thresholds,
  policy: string,
): GateResult {
  const limits = thresholds.harnessCheck[policy];
  if (limits === undefined) throw new Error(`No harness check for policy "${policy}"`);
  const checks: GateCheck[] = [];
  for (const [metric, min] of Object.entries(limits.min ?? {})) {
    checks.push(check('harness', metric, { min }, summary.metrics[metric]?.mean ?? null));
  }
  for (const [metric, max] of Object.entries(limits.max ?? {})) {
    checks.push(check('harness', metric, { max }, summary.metrics[metric]?.mean ?? null));
  }
  // A control metric with no applicable case means the wiring is broken, not "not applicable".
  const strict = checks.map((item) =>
    item.outcome === 'not_applicable' ? { ...item, outcome: 'fail' as const } : item,
  );
  return {
    verdict: strict.some((item) => item.outcome === 'fail') ? 'fail' : 'pass',
    checks: strict,
    pendingSoftGates: 0,
  };
}

/**
 * Proposed soft thresholds from a measured run: the baseline mean minus (or plus, for
 * lower-is-better metrics) the half-width of its 95 % interval, never beyond [0, 1]. For a human
 * to review and copy into thresholds.json; never applied automatically.
 */
export function proposeSoftThresholds(
  summary: RunSummary,
  thresholds: Thresholds,
  lowerIsBetter: ReadonlySet<string>,
  source: string,
): Record<string, Bound> {
  const proposals: Record<string, Bound> = {};
  for (const metric of Object.keys(thresholds.soft.metrics)) {
    const measured = summary.metrics[metric];
    if (measured === undefined) continue;
    const margin = (measured.interval.high - measured.interval.low) / 2;
    const round = (value: number) => Math.round(Math.min(1, Math.max(0, value)) * 1000) / 1000;
    proposals[metric] = lowerIsBetter.has(metric.replace(/^judge\./, ''))
      ? {
          max: round(measured.mean + margin),
          baseline: round(measured.mean),
          margin: round(margin),
          source,
        }
      : {
          min: round(measured.mean - margin),
          baseline: round(measured.mean),
          margin: round(margin),
          source,
        };
  }
  return proposals;
}
