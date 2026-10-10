/**
 * Token estimation for chunk budgets, without loading the embedding model's tokenizer (the
 * chunker is pure and runs in unit tests and at ingestion before any model is loaded).
 *
 * Estimator: the text is cut into lexical pieces, runs of letters/digits and single symbols.
 * A symbol counts one token; a run counts one token per started block of 7 characters, which
 * approximates how WordPiece splits long or rare words into sub-words.
 *
 * Calibration (2026-10-10, `bge-small-en-v1.5` WordPiece tokenizer, the 2,749 non-empty lines of
 * the 20 destination guides, 117,107 real tokens): estimated/real total ratio 1.000, per-line
 * relative error p5 -22 % / median 0 % / p95 +21 %. Simpler rules were further off: chars/4
 * over-counts by 8.5 % in total (p5 -40 %, p95 +38 %), words x 1.3 under-counts by 5.5 %.
 * The estimate is a budget heuristic, not an exact count: the embedder truncates at 512 real
 * tokens, so chunk sizes stay well below that.
 */

const PIECE = /[\p{L}\p{M}\p{N}]+|[^\s\p{L}\p{M}\p{N}]/gu;
const WORD_RUN = /^[\p{L}\p{M}\p{N}]/u;
const CHARS_PER_SUBWORD = 7;

export function estimateTokens(text: string): number {
  let tokens = 0;
  for (const match of text.matchAll(PIECE)) {
    const piece = match[0];
    tokens += WORD_RUN.test(piece) ? Math.ceil(piece.length / CHARS_PER_SUBWORD) : 1;
  }
  return tokens;
}

export type TokenEstimator = (text: string) => number;
