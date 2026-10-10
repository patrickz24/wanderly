/**
 * `websearch_to_tsquery` ANDs every word: a natural-language question ("which beaches suit
 * families in summer") then matches almost no chunk. In "any" mode the words are joined with
 * the `or` operator of the websearch syntax instead, and `ts_rank_cd` ranks the chunks matching
 * more of them (and closer together) first, like a bag-of-words engine. Quotes and the `-`
 * negation are dropped on purpose: the agent writes these queries, not a power user.
 */
export type FullTextMatch = 'all' | 'any';

const TERM = /[\p{L}\p{N}]+(?:['’][\p{L}]+)?/gu;

export function toWebSearchQuery(text: string, match: FullTextMatch): string {
  if (match === 'all') return text;
  const terms = [...text.matchAll(TERM)].map((term) => term[0]);
  // A lone "or" would become the operator itself: it carries no meaning, drop it.
  return terms.filter((term) => term.toLowerCase() !== 'or').join(' or ');
}
