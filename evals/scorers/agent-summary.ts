import type { CaseCategory } from '../runner/agent-dataset.js';
import {
  AGENT_METRICS,
  type AgentMetric,
  type MetricScores,
  type RunStatus,
} from './agent-metrics.js';
import {
  bootstrapMeanInterval,
  mean,
  pairedDifferenceInterval,
  type Interval,
} from './retrieval-metrics.js';

/**
 * Aggregation of the per-(case, rep) scores: per metric, the mean over cases of each case's mean
 * over reps (every case weighs the same whatever its rep count), with a 95 % percentile bootstrap
 * interval over cases. Not-applicable scores (null) are left out of their metric only.
 */

/** One scored (case, rep): what results.jsonl holds. */
export interface ScoredRow {
  readonly caseId: string;
  readonly category: CaseCategory;
  readonly rep: number;
  readonly status: RunStatus;
  readonly scores: MetricScores;
  /** Judge scores (null when the judge did not run or does not apply). */
  readonly judge: Readonly<Record<string, number | null>>;
  readonly costUsd: number;
  readonly judgeCostUsd: number;
  readonly latencyMs: number;
  readonly steps: number;
  readonly attempts: number;
}

export interface MetricSummary {
  readonly mean: number;
  /** Number of cases with at least one applicable score. */
  readonly n: number;
  readonly interval: Interval;
}

export interface PerfSummary {
  readonly agentCostUsd: number;
  readonly judgeCostUsd: number;
  readonly meanAgentCostPerRunUsd: number;
  readonly latencyP50Ms: number;
  readonly latencyP95Ms: number;
  readonly meanSteps: number;
  readonly maxSteps: number;
  /** Attempts beyond the first, over all scored rows (infra retries). */
  readonly retries: number;
}

export interface RunSummary {
  readonly cases: number;
  readonly reps: number;
  readonly scoredRows: number;
  readonly statuses: Readonly<Record<RunStatus, number>>;
  readonly metrics: Readonly<Partial<Record<string, MetricSummary>>>;
  readonly byCategory: Readonly<Partial<Record<CaseCategory, Partial<Record<string, number>>>>>;
  readonly perf: PerfSummary;
  /** Rough noise floor of a pass rate at this n x reps: 1 / sqrt(n x reps). */
  readonly noiseFloor: number;
}

/** Per-case mean over reps of one metric (cases with no applicable score are absent). */
export function perCaseMeans(
  rows: readonly ScoredRow[],
  read: (row: ScoredRow) => number | null,
): Map<string, number> {
  const byCase = new Map<string, number[]>();
  for (const row of rows) {
    const value = read(row);
    if (value === null) continue;
    const values = byCase.get(row.caseId) ?? [];
    values.push(value);
    byCase.set(row.caseId, values);
  }
  return new Map([...byCase].map(([caseId, values]) => [caseId, mean(values)]));
}

export function summarizeMetric(
  rows: readonly ScoredRow[],
  read: (row: ScoredRow) => number | null,
): MetricSummary | undefined {
  const values = [...perCaseMeans(rows, read).values()];
  if (values.length === 0) return undefined;
  return { mean: mean(values), n: values.length, interval: bootstrapMeanInterval(values) };
}

/** Nearest-rank percentile (p in [0, 100]). */
export function percentile(values: readonly number[], p: number): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((left, right) => left - right);
  const rank = Math.ceil((p / 100) * sorted.length);
  return sorted[Math.min(sorted.length - 1, Math.max(0, rank - 1))] as number;
}

export const JUDGE_METRICS = ['faithfulness_rate', 'faithful', 'request_fit'] as const;

export function summarizeRun(rows: readonly ScoredRow[]): RunSummary {
  const metrics: Partial<Record<string, MetricSummary>> = {};
  for (const metric of AGENT_METRICS) {
    const summary = summarizeMetric(rows, (row) => row.scores[metric]);
    if (summary !== undefined) metrics[metric] = summary;
  }
  for (const metric of JUDGE_METRICS) {
    const summary = summarizeMetric(rows, (row) => row.judge[metric] ?? null);
    if (summary !== undefined) metrics[`judge.${metric}`] = summary;
  }

  const byCategory: Partial<Record<CaseCategory, Partial<Record<string, number>>>> = {};
  const categories = [...new Set(rows.map((row) => row.category))];
  for (const category of categories) {
    const inCategory = rows.filter((row) => row.category === category);
    const entry: Partial<Record<string, number>> = {};
    for (const metric of CATEGORY_METRICS) {
      const summary = summarizeMetric(inCategory, (row) => row.scores[metric]);
      if (summary !== undefined) entry[metric] = summary.mean;
    }
    entry['cases'] = new Set(inCategory.map((row) => row.caseId)).size;
    byCategory[category] = entry;
  }

  const statuses: Record<RunStatus, number> = { ok: 0, refusal: 0, truncated: 0, model_error: 0 };
  for (const row of rows) statuses[row.status] += 1;
  const caseCount = new Set(rows.map((row) => row.caseId)).size;
  const reps = rows.length === 0 ? 0 : Math.max(...rows.map((row) => row.rep));
  const latencies = rows.filter((row) => row.status === 'ok').map((row) => row.latencyMs);
  const agentCostUsd = rows.reduce((sum, row) => sum + row.costUsd, 0);
  return {
    cases: caseCount,
    reps,
    scoredRows: rows.length,
    statuses,
    metrics,
    byCategory,
    perf: {
      agentCostUsd,
      judgeCostUsd: rows.reduce((sum, row) => sum + row.judgeCostUsd, 0),
      meanAgentCostPerRunUsd: rows.length === 0 ? 0 : agentCostUsd / rows.length,
      latencyP50Ms: percentile(latencies, 50),
      latencyP95Ms: percentile(latencies, 95),
      meanSteps: rows.length === 0 ? 0 : mean(rows.map((row) => row.steps)),
      maxSteps: rows.length === 0 ? 0 : Math.max(...rows.map((row) => row.steps)),
      retries: rows.reduce((sum, row) => sum + row.attempts - 1, 0),
    },
    noiseFloor: rows.length === 0 ? 1 : 1 / Math.sqrt(caseCount * Math.max(1, reps)),
  };
}

/** Metrics shown per category in the report. */
export const CATEGORY_METRICS: readonly AgentMetric[] = [
  'response_type_correct',
  'guardrail_pass',
  'constraint_fit',
  'citation_integrity',
];

/**
 * Paired comparison of two runs on the cases both scored (e.g. Haiku vs Sonnet, or a change vs
 * the baseline): mean difference B - A with a 95 % bootstrap interval over cases.
 */
export function compareRuns(
  a: readonly ScoredRow[],
  b: readonly ScoredRow[],
  metric: AgentMetric,
): (Interval & { readonly mean: number; readonly n: number }) | undefined {
  const left = perCaseMeans(a, (row) => row.scores[metric]);
  const right = perCaseMeans(b, (row) => row.scores[metric]);
  const shared = [...left.keys()].filter((caseId) => right.has(caseId)).sort();
  if (shared.length === 0) return undefined;
  const interval = pairedDifferenceInterval(
    shared.map((caseId) => right.get(caseId) as number),
    shared.map((caseId) => left.get(caseId) as number),
  );
  return { ...interval, n: shared.length };
}
