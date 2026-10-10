/**
 * Deterministic curation of `crowd_level` and `best_months` (pure, lexical, no model).
 *
 * For each POI the evidence pool is its own rendered text (listing or list item) plus the
 * sentences of the paragraphs of its source section that name it. Only sentences that appear
 * verbatim in the rendered section are kept, so every evidence string can be found in the
 * Markdown document. crowds.ts and seasons.ts then read the pool with their documented lexicons.
 */
import { assessCrowd } from './crowds.js';
import { assessBestMonths } from './seasons.js';

/** Splits rendered text after ".", "!" or "?" followed by whitespace; pieces stay verbatim. */
export function splitSentences(text: string): string[] {
  return text
    .split(/(?<=[.!?])\s+/)
    .map((sentence) => sentence.trim())
    .filter((sentence) => sentence !== '');
}

/** Names shorter than this are too likely to match unrelated words in paragraphs. */
const MIN_NAME_LENGTH = 4;

export function evidencePool(input: {
  readonly name: string;
  readonly ownText: string;
  readonly paragraphs: readonly string[];
  readonly sectionMarkdown: string;
}): string[] {
  const name = input.name.toLowerCase();
  const mentions =
    name.length < MIN_NAME_LENGTH
      ? []
      : input.paragraphs
          .flatMap(splitSentences)
          .filter((sentence) => sentence.toLowerCase().includes(name));
  const pool = [...splitSentences(input.ownText), ...mentions];
  return [...new Set(pool)].filter((sentence) => input.sectionMarkdown.includes(sentence));
}

export interface Curation {
  readonly crowd_level: number | null;
  readonly crowd_evidence: string[];
  readonly best_months: number[];
  readonly months_evidence: string[];
}

export function curate(sentences: readonly string[]): Curation {
  const crowd = assessCrowd(sentences);
  const months = assessBestMonths(sentences);
  return {
    crowd_level: crowd.level,
    crowd_evidence: [...crowd.evidence],
    best_months: months.months,
    months_evidence: [...months.evidence],
  };
}
