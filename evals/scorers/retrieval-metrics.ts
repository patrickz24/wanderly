/* eslint-disable @typescript-eslint/no-unused-vars -- learning skeleton: the parameters and helpers are used once the TODOs are implemented; remove this line at the end. */
/**
 * Retrieval metrics over section labels (pure functions).
 *
 * A query is labelled with target sections `(destinationId, document, headingPath)`. A retrieved
 * chunk is relevant to a target when it comes from the same document and one of the sections it
 * covers is the target section or one of its subsections. Labels therefore survive re-chunking:
 * a section split into three chunks has three relevant chunks, and a chunk merging two small
 * sections is relevant to both.
 */

/*
 * SQUELETTE D'EXERCICE (branche learning/eval-metrics). Guide : docs/learning/eval-metrics.md sur
 * main ; ordre des étapes : LEARNING.md à la racine de la branche.
 * Fourni : les types, `mean`, le générateur pseudo-aléatoire `seededRandom` et `assertK`.
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
  // TODO(learning) — étape 1. Spec : retrieval-metrics.test.ts, describe('relevance').
  // Vrai si l'une des sections couvertes EST la section cible ou une de ses sous-sections.
  // Piège : « Do > Hiking trails » n'est pas une sous-section de « Do > Hiking » (pense au
  // séparateur).
  throw new Error('TODO(learning): coversSection (eval-metrics, step 1)');
}

export function isRelevant(result: RetrievedSections, target: SectionTarget): boolean {
  // TODO(learning) — étape 1. Même destination, même document (attention : le chemin du résultat
  // est relatif à la racine du corpus, celui de la cible à sa destination), et section couverte.
  throw new Error('TODO(learning): isRelevant (eval-metrics, step 1)');
}

/** For each ranked result, the indexes of the targets it is relevant to. */
export function matchTargets(
  results: readonly RetrievedSections[],
  targets: readonly SectionTarget[],
): number[][] {
  // TODO(learning) — étape 1. Une ligne par résultat (dans l'ordre du classement) : la liste des
  // indices des cibles pour lesquelles ce résultat est pertinent (souvent vide). Toutes les
  // métriques de rang se calculent ensuite sur cette matrice, sans regarder le texte.
  throw new Error('TODO(learning): matchTargets (eval-metrics, step 1)');
}

/** Share of the targets found in the first `k` results (each target counts once). */
export function recallAtK(
  matches: readonly (readonly number[])[],
  targetCount: number,
  k: number,
): number {
  // TODO(learning) — étape 2. Valide `k` (`assertK`) et refuse une requête sans cible
  // (RangeError). Puis : nombre de cibles DISTINCTES trouvées dans les k premiers résultats,
  // divisé par le nombre de cibles. Trois chunks de la même section ne comptent qu'une fois.
  throw new Error('TODO(learning): recallAtK (eval-metrics, step 2)');
}

/** 1 / rank of the first relevant result within the first `k`, 0 when there is none. */
export function reciprocalRankAtK(matches: readonly (readonly number[])[], k: number): number {
  // TODO(learning) — étape 2. Valide `k`. Rang 1-based du premier résultat pertinent parmi les k
  // premiers : renvoie 1 / rang, ou 0 s'il n'y en a pas.
  throw new Error('TODO(learning): reciprocalRankAtK (eval-metrics, step 2)');
}

/** 1 when at least one relevant result is in the first `k`, else 0. */
export function hitAtK(matches: readonly (readonly number[])[], k: number): number {
  // TODO(learning) — étape 2. Se déduit de la métrique précédente (et valide donc `k` aussi).
  throw new Error('TODO(learning): hitAtK (eval-metrics, step 2)');
}

/** 1-based rank of the first relevant result, null when none was retrieved. */
export function firstRelevantRank(matches: readonly (readonly number[])[]): number | null {
  // TODO(learning) — étape 2. Sur toute la liste (pas de k) : sert au diagnostic par requête.
  throw new Error('TODO(learning): firstRelevantRank (eval-metrics, step 2)');
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
  // TODO(learning) — étape 2. Calcule la matrice UNE fois, puis les cinq métriques du rapport.
  throw new Error('TODO(learning): scoreQuery (eval-metrics, step 2)');
}

export const METRIC_NAMES = ['recallAt5', 'recallAt10', 'mrrAt10', 'hitAt1', 'hitAt5'] as const;
export type MetricName = (typeof METRIC_NAMES)[number];

export function mean(values: readonly number[]): number {
  if (values.length === 0) throw new RangeError('mean of no values');
  return values.reduce((total, value) => total + value, 0) / values.length;
}

/** Mean of each metric over the queries (macro average: every query weighs the same). */
export function averageScores(scores: readonly QueryScores[]): QueryScores {
  // TODO(learning) — étape 2. Moyenne MACRO : chaque requête pèse pareil, quel que soit son
  // nombre de cibles.
  throw new Error('TODO(learning): averageScores (eval-metrics, step 2)');
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
  // TODO(learning) — étape 3. Spec : describe('bootstrap intervals').
  // 1. Aucune valeur -> RangeError.
  // 2. `resamples` fois : tire n valeurs AVEC REMISE (n = nombre de valeurs) avec le générateur
  //    `seededRandom(seed)`, et garde la moyenne de cet échantillon.
  // 3. Trie les moyennes ; l'intervalle va du quantile (1 − confidence) / 2 au quantile
  //    1 − (1 − confidence) / 2 de cette distribution (méthode des percentiles). Borne les indices
  //    pour rester dans le tableau.
  // Même graine -> même intervalle : un rapport ne bouge pas si rien d'autre n'a bougé.
  throw new Error('TODO(learning): bootstrapMeanInterval (eval-metrics, step 3)');
}

/** Bootstrap interval of the mean paired difference `a[i] - b[i]` (same queries, two systems). */
export function pairedDifferenceInterval(
  a: readonly number[],
  b: readonly number[],
  options: BootstrapOptions = {},
): Interval & { readonly mean: number } {
  // TODO(learning) — étape 3. Deux systèmes notés sur les MÊMES requêtes : longueurs différentes
  // -> RangeError. Calcule la différence requête par requête, puis sa moyenne et son intervalle
  // bootstrap. Pourquoi apparier : la difficulté propre à chaque requête s'annule dans la
  // différence, et l'intervalle est bien plus étroit que deux intervalles comparés à l'œil.
  throw new Error('TODO(learning): pairedDifferenceInterval (eval-metrics, step 3)');
}

function assertK(k: number): void {
  if (!Number.isInteger(k) || k < 1)
    throw new RangeError(`k must be a positive integer (got ${k})`);
}
