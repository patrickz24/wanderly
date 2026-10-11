/* eslint-disable @typescript-eslint/no-unused-vars -- learning skeleton: the parameters are used once the TODOs are implemented; remove this line at the end. */
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
  // TODO(learning) — étape 2. Spec : rrf.test.ts.
  // 1. Valide les options : `k` (défaut DEFAULT_RRF_K) doit être un nombre fini > 0 ; `limit`, s'il
  //    est donné, un entier ≥ 0. Sinon : RangeError.
  // 2. Pour chaque liste (dans l'ordre des clés) et chaque id : retiens son rang 1-based dans
  //    cette liste, `null` dans les listes où il n'apparaît pas. Un id répété dans une même liste
  //    garde son PREMIER rang.
  // 3. Score de chaque id : somme de 1 / (k + rang) sur les listes où il apparaît. Additionne
  //    toujours dans le même ordre (celui des listes) : l'addition flottante n'est pas
  //    associative, et le test de déterminisme compare des scores au bit près.
  // 4. Trie (`compare`), puis applique `limit` APRÈS la fusion.
  throw new Error('TODO(learning): reciprocalRankFusion (chunking-rrf, step 2)');
}

function compare<ListName extends string>(
  left: FusedResult<ListName>,
  right: FusedResult<ListName>,
  names: readonly ListName[],
): number {
  // TODO(learning) — étape 2. Ordre total et déterministe (sinon deux recherches identiques
  // pourraient rendre des résultats dans un ordre différent) :
  // 1. score décroissant ;
  // 2. à égalité, le meilleur rang (le plus petit, toutes listes confondues) d'abord ;
  // 3. encore à égalité, le rang dans la première liste, puis la deuxième, etc. (absent = +∞).
  throw new Error('TODO(learning): compare (chunking-rrf, step 2)');
}
