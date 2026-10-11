/* eslint-disable @typescript-eslint/no-unused-vars -- learning skeleton: the parameters are used once the TODOs are implemented; remove this line at the end. */
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

/*
 * SQUELETTE D'EXERCICE (branche learning/eval-metrics), étape 9 : la partie statistique
 * (`perCaseMeans`, `summarizeMetric`, `percentile`, `compareRuns`). `summarizeRun`, qui assemble
 * le résumé du run, est fourni.
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
  // TODO(learning) — étape 9. Spec : agent-summary.test.ts, describe('summarizeRun').
  // Regroupe les valeurs par cas en IGNORANT les null (non applicable), puis fais la moyenne de
  // chaque cas sur ses répétitions. Un cas sans aucune valeur applicable est absent du résultat.
  // Pourquoi d'abord par cas : avec `--reps`, un cas répété 3 fois ne doit pas peser 3 fois plus.
  throw new Error('TODO(learning): perCaseMeans (eval-metrics, step 9)');
}

export function summarizeMetric(
  rows: readonly ScoredRow[],
  read: (row: ScoredRow) => number | null,
): MetricSummary | undefined {
  // TODO(learning) — étape 9. Moyenne des moyennes par cas, `n` = nombre de cas notés, et
  // l'intervalle bootstrap de cette moyenne (sur les CAS, l'unité d'échantillonnage). Aucune
  // valeur applicable -> undefined (la métrique est absente du rapport, pas « 0 % »).
  throw new Error('TODO(learning): summarizeMetric (eval-metrics, step 9)');
}

/** Nearest-rank percentile (p in [0, 100]). */
export function percentile(values: readonly number[], p: number): number {
  // TODO(learning) — étape 9. Spec : describe('percentile'). Méthode du rang le plus proche :
  // trie une COPIE, prends l'élément de rang ceil(p / 100 × n) (1-based), borné au tableau.
  // Liste vide -> 0.
  throw new Error('TODO(learning): percentile (eval-metrics, step 9)');
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
  // TODO(learning) — étape 9. Spec : describe('compareRuns').
  // 1. Moyennes par cas de la métrique, pour chaque run.
  // 2. Ne garde que les cas notés dans LES DEUX runs (triés, pour un ordre stable) ; aucun ->
  //    undefined.
  // 3. Différence appariée B − A (`pairedDifferenceInterval`, attention à l'ordre des arguments),
  //    avec `n` = nombre de cas partagés.
  throw new Error('TODO(learning): compareRuns (eval-metrics, step 9)');
}
