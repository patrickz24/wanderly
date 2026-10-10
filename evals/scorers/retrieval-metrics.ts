/**
 * Retrieval metrics over section labels (pure functions).
 *
 * A query is labelled with target sections `(destinationId, document, headingPath)`. A retrieved
 * chunk is relevant to a target when it comes from the same document and one of the sections it
 * covers is the target section or one of its subsections. Labels therefore survive re-chunking:
 * a section split into three chunks has three relevant chunks, and a chunk merging two small
 * sections is relevant to both.
 */

export interface SectionTarget {
  readonly destinationId: string;
  /** Path relative to `data/corpus/<destinationId>/`, e.g. "guide.md". */
  readonly document: string;
  /** Section path inside the document, without the document title, e.g. "Do > Hiking". */
  readonly headingPath: string;
}

export interface RetrievedSections {
  readonly destinationId: string;
  /** Path relative to the corpus root, e.g. "sicily/guide.md". */
  readonly documentPath: string;
  /** Sections the chunk covers, relative to its document. */
  readonly sections: readonly string[];
}

const SEPARATOR = ' > ';

export function coversSection(sections: readonly string[], headingPath: string): boolean {
  return sections.some(
    (section) => section === headingPath || section.startsWith(`${headingPath}${SEPARATOR}`),
  );
}

export function isRelevant(result: RetrievedSections, target: SectionTarget): boolean {
  return (
    result.destinationId === target.destinationId &&
    result.documentPath === `${target.destinationId}/${target.document}` &&
    coversSection(result.sections, target.headingPath)
  );
}

/** For each ranked result, the indexes of the targets it is relevant to. */
export function matchTargets(
  results: readonly RetrievedSections[],
  targets: readonly SectionTarget[],
): number[][] {
  return results.map((result) =>
    targets.flatMap((target, index) => (isRelevant(result, target) ? [index] : [])),
  );
}

/** Share of the targets found in the first `k` results (each target counts once). */
export function recallAtK(
  matches: readonly (readonly number[])[],
  targetCount: number,
  k: number,
): number {
  assertK(k);
  if (targetCount <= 0) throw new RangeError('a query needs at least one target');
  const found = new Set(matches.slice(0, k).flat());
  return found.size / targetCount;
}

/** 1 / rank of the first relevant result within the first `k`, 0 when there is none. */
export function reciprocalRankAtK(matches: readonly (readonly number[])[], k: number): number {
  assertK(k);
  const index = matches.slice(0, k).findIndex((targets) => targets.length > 0);
  return index === -1 ? 0 : 1 / (index + 1);
}

/** 1 when at least one relevant result is in the first `k`, else 0. */
export function hitAtK(matches: readonly (readonly number[])[], k: number): number {
  return reciprocalRankAtK(matches, k) > 0 ? 1 : 0;
}

/** 1-based rank of the first relevant result, null when none was retrieved. */
export function firstRelevantRank(matches: readonly (readonly number[])[]): number | null {
  const index = matches.findIndex((targets) => targets.length > 0);
  return index === -1 ? null : index + 1;
}

export interface QueryScores {
  readonly recallAt5: number;
  readonly recallAt10: number;
  readonly mrrAt10: number;
  readonly hitAt1: number;
  readonly hitAt5: number;
}

export function scoreQuery(
  results: readonly RetrievedSections[],
  targets: readonly SectionTarget[],
): QueryScores {
  const matches = matchTargets(results, targets);
  return {
    recallAt5: recallAtK(matches, targets.length, 5),
    recallAt10: recallAtK(matches, targets.length, 10),
    mrrAt10: reciprocalRankAtK(matches, 10),
    hitAt1: hitAtK(matches, 1),
    hitAt5: hitAtK(matches, 5),
  };
}

export const METRIC_NAMES = ['recallAt5', 'recallAt10', 'mrrAt10', 'hitAt1', 'hitAt5'] as const;
export type MetricName = (typeof METRIC_NAMES)[number];

export function mean(values: readonly number[]): number {
  if (values.length === 0) throw new RangeError('mean of no values');
  return values.reduce((total, value) => total + value, 0) / values.length;
}

/** Mean of each metric over the queries (macro average: every query weighs the same). */
export function averageScores(scores: readonly QueryScores[]): QueryScores {
  const average = (name: MetricName) => mean(scores.map((score) => score[name]));
  return {
    recallAt5: average('recallAt5'),
    recallAt10: average('recallAt10'),
    mrrAt10: average('mrrAt10'),
    hitAt1: average('hitAt1'),
    hitAt5: average('hitAt5'),
  };
}

export interface Interval {
  readonly low: number;
  readonly high: number;
}

/**
 * Deterministic pseudo-random generator (mulberry32): the same seed gives the same intervals on
 * every run, so a report does not change when nothing else did.
 */
export function seededRandom(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let value = Math.imul(state ^ (state >>> 15), 1 | state);
    value = (value + Math.imul(value ^ (value >>> 7), 61 | value)) ^ value;
    return ((value ^ (value >>> 14)) >>> 0) / 4294967296;
  };
}

export interface BootstrapOptions {
  readonly resamples?: number;
  readonly confidence?: number;
  readonly seed?: number;
}

/**
 * Percentile bootstrap interval of the mean of `values` (queries resampled with replacement).
 * With a few dozen queries the intervals are wide: they say how far a difference can be noise.
 */
export function bootstrapMeanInterval(
  values: readonly number[],
  { resamples = 2000, confidence = 0.95, seed = 42 }: BootstrapOptions = {},
): Interval {
  if (values.length === 0) throw new RangeError('bootstrap of no values');
  const random = seededRandom(seed);
  const means: number[] = [];
  for (let sample = 0; sample < resamples; sample++) {
    let total = 0;
    for (let draw = 0; draw < values.length; draw++) {
      total += values[Math.floor(random() * values.length)] as number;
    }
    means.push(total / values.length);
  }
  means.sort((left, right) => left - right);
  const tail = (1 - confidence) / 2;
  const at = (quantile: number) =>
    means[Math.min(means.length - 1, Math.max(0, Math.floor(quantile * means.length)))] as number;
  return { low: at(tail), high: at(1 - tail) };
}

/** Bootstrap interval of the mean paired difference `a[i] - b[i]` (same queries, two systems). */
export function pairedDifferenceInterval(
  a: readonly number[],
  b: readonly number[],
  options: BootstrapOptions = {},
): Interval & { readonly mean: number } {
  if (a.length !== b.length) throw new RangeError('paired samples must have the same length');
  const differences = a.map((value, index) => value - (b[index] as number));
  return { mean: mean(differences), ...bootstrapMeanInterval(differences, options) };
}

function assertK(k: number): void {
  if (!Number.isInteger(k) || k < 1)
    throw new RangeError(`k must be a positive integer (got ${k})`);
}
