import type { Interval, QueryScores } from '../scorers/retrieval-metrics.js';

export interface ConfigurationSummary {
  readonly chunking: string;
  readonly strategy: string;
  readonly chunks: number;
  readonly metrics: QueryScores;
  readonly intervals: { readonly mrrAt10: Interval; readonly recallAt5: Interval };
  readonly medianLatencyMs: number;
}

const percent = (value: number): string => (value * 100).toFixed(1);
const range = (interval: Interval): string => `${percent(interval.low)}–${percent(interval.high)}`;

/** Markdown table of the measured configurations (metrics in %, 95 % bootstrap intervals). */
export function renderTable(rows: readonly ConfigurationSummary[]): string {
  const header = [
    '| Chunking | Strategy | Chunks | Recall@5 | Recall@10 | MRR@10 | Hit@1 | Hit@5 | p50 latency |',
    '|---|---|---:|---:|---:|---:|---:|---:|---:|',
  ];
  const lines = rows.map((row) =>
    [
      row.chunking,
      row.strategy,
      String(row.chunks),
      `${percent(row.metrics.recallAt5)} (${range(row.intervals.recallAt5)})`,
      percent(row.metrics.recallAt10),
      `${percent(row.metrics.mrrAt10)} (${range(row.intervals.mrrAt10)})`,
      percent(row.metrics.hitAt1),
      percent(row.metrics.hitAt5),
      `${row.medianLatencyMs.toFixed(0)} ms`,
    ].join(' | '),
  );
  return [...header, ...lines.map((line) => `| ${line} |`)].join('\n');
}

export const RESULTS_START = '<!-- retrieval-results:start -->';
export const RESULTS_END = '<!-- retrieval-results:end -->';

/** Replaces what is between the markers, keeping the hand-written text around them. */
export function replaceBetweenMarkers(document: string, content: string): string {
  const start = document.indexOf(RESULTS_START);
  const end = document.indexOf(RESULTS_END);
  if (start === -1 || end === -1 || end < start) {
    throw new Error(`markers ${RESULTS_START} … ${RESULTS_END} not found`);
  }
  return `${document.slice(0, start + RESULTS_START.length)}\n\n${content.trim()}\n\n${document.slice(end)}`;
}

export function median(values: readonly number[]): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((left, right) => left - right);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1
    ? (sorted[middle] as number)
    : ((sorted[middle - 1] as number) + (sorted[middle] as number)) / 2;
}
