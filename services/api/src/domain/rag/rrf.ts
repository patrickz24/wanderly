/**
 * Reciprocal Rank Fusion (Cormack, Clarke & Büttcher, SIGIR 2009):
 * `score(d) = Σ over lists of 1 / (k + rank_list(d))`, 1-based ranks, absent = no contribution.
 *
 * Only ranks are used, so lists whose scores live on different scales (cosine distance and
 * `ts_rank_cd`) are fused without any normalization. `k` damps the advantage of the very first
 * ranks; 60 is the value of the original paper.
 */

export const DEFAULT_RRF_K = 60;

export interface FusedResult<ListName extends string> {
  readonly id: string;
  readonly score: number;
  /** 1-based rank in each input list, null when the id is absent from it. */
  readonly ranks: Readonly<Record<ListName, number | null>>;
}

export interface RrfOptions {
  readonly k?: number;
  /** Keep only the best `limit` results. */
  readonly limit?: number;
}

/**
 * Fuses ranked lists of ids (best first). Ties are broken deterministically: higher score, then
 * the better best rank across lists, then the rank in the earliest list (in key order).
 * A duplicate id inside one list keeps its first (best) rank.
 */
export function reciprocalRankFusion<ListName extends string>(
  lists: Readonly<Record<ListName, readonly string[]>>,
  options: RrfOptions = {},
): FusedResult<ListName>[] {
  const k = options.k ?? DEFAULT_RRF_K;
  if (!Number.isFinite(k) || k <= 0) throw new RangeError(`k must be a positive number (got ${k})`);
  const limit = options.limit;
  if (limit !== undefined && (!Number.isInteger(limit) || limit < 0)) {
    throw new RangeError(`limit must be a non-negative integer (got ${limit})`);
  }

  const names = Object.keys(lists) as ListName[];
  const ranksById = new Map<string, Record<ListName, number | null>>();

  for (const name of names) {
    lists[name].forEach((id, index) => {
      let ranks = ranksById.get(id);
      if (ranks === undefined) {
        ranks = Object.fromEntries(names.map((other) => [other, null])) as Record<
          ListName,
          number | null
        >;
        ranksById.set(id, ranks);
      }
      if (ranks[name] === null) ranks[name] = index + 1;
    });
  }

  const fused = [...ranksById].map(([id, ranks]) => ({
    id,
    ranks,
    // Summed in list order so that the floating-point result does not depend on map order.
    score: names.reduce((total, name) => {
      const rank = ranks[name];
      return rank === null ? total : total + 1 / (k + rank);
    }, 0),
  }));

  fused.sort((left, right) => compare(left, right, names));
  return limit === undefined ? fused : fused.slice(0, limit);
}

function compare<ListName extends string>(
  left: FusedResult<ListName>,
  right: FusedResult<ListName>,
  names: readonly ListName[],
): number {
  if (left.score !== right.score) return right.score - left.score;
  // Every fused id appears in at least one list, so its best rank is finite.
  const bestRank = (result: FusedResult<ListName>): number =>
    Math.min(...names.map((name) => result.ranks[name] ?? Number.POSITIVE_INFINITY));
  const byBest = bestRank(left) - bestRank(right);
  if (byBest !== 0) return byBest;
  // Two distinct ids never share a rank in the same list, so this always decides.
  for (const name of names) {
    const a = left.ranks[name] ?? Number.POSITIVE_INFINITY;
    const b = right.ranks[name] ?? Number.POSITIVE_INFINITY;
    if (a !== b) return a - b;
  }
  return 0;
}
