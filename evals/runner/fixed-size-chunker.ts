import {
  BREADCRUMB_SEPARATOR,
  type Chunk,
  type DocumentChunker,
} from '../../services/api/src/domain/rag/chunker.js';
import { estimateTokens } from '../../services/api/src/domain/rag/tokens.js';

/**
 * Baseline for the evaluation (plan section 6, option 1): fixed windows of about `sizeTokens`
 * estimated tokens with `overlapTokens` of overlap, cut between words with no regard for the
 * document structure, and no contextual header. Each window records the sections it overlaps so
 * that the same section labels can score it.
 */
export interface FixedSizeOptions {
  readonly sizeTokens: number;
  readonly overlapTokens: number;
}

const HEADING = /^(#{1,3})[ \t]+(.*?)[ \t]*#*[ \t]*$/;

interface Word {
  readonly text: string;
  readonly tokens: number;
  readonly section: string;
}

export function fixedSizeChunker({ sizeTokens, overlapTokens }: FixedSizeOptions): DocumentChunker {
  if (!Number.isInteger(sizeTokens) || sizeTokens < 1)
    throw new RangeError('sizeTokens must be >= 1');
  if (!Number.isInteger(overlapTokens) || overlapTokens < 0 || overlapTokens >= sizeTokens) {
    throw new RangeError('overlapTokens must be in [0, sizeTokens)');
  }
  return {
    fingerprint: `fixed-v1;size=${sizeTokens};overlap=${overlapTokens};header=off`,
    chunk: ({ title, markdown }) => {
      const words = toWords(markdown);
      const chunks: Chunk[] = [];
      let start = 0;
      while (start < words.length) {
        let end = start;
        let tokens = 0;
        while (
          end < words.length &&
          (end === start || tokens + (words[end] as Word).tokens <= sizeTokens)
        ) {
          tokens += (words[end] as Word).tokens;
          end++;
        }
        const window = words.slice(start, end);
        const content = window.map((word) => word.text).join(' ');
        const sections = [...new Set(window.map((word) => word.section))];
        const first = sections[0] ?? '';
        chunks.push({
          ordinal: chunks.length,
          headingPath: first === '' ? title : `${title}${BREADCRUMB_SEPARATOR}${first}`,
          sections,
          content,
          text: content,
          tokenCount: estimateTokens(content),
        });
        if (end >= words.length) break;
        // Step back over whole words to repeat about `overlapTokens` tokens.
        let back = end;
        let overlap = 0;
        while (back > start + 1 && overlap + (words[back - 1] as Word).tokens <= overlapTokens) {
          overlap += (words[back - 1] as Word).tokens;
          back--;
        }
        start = back;
      }
      return chunks;
    },
  };
}

/** Words of the body with the section they belong to; heading lines are kept as words too. */
function toWords(markdown: string): Word[] {
  const words: Word[] = [];
  let h2: string | null = null;
  let section = '';
  let seenTitle = false;
  for (const line of markdown.replace(/\r\n?/g, '\n').split('\n')) {
    const heading = HEADING.exec(line);
    if (heading !== null) {
      const level = heading[1]?.length ?? 0;
      const name = heading[2] ?? '';
      if (level === 1 && !seenTitle) {
        seenTitle = true;
        continue;
      }
      if (level <= 2) {
        h2 = name;
        section = name;
      } else {
        section = h2 === null ? name : `${h2}${BREADCRUMB_SEPARATOR}${name}`;
      }
    }
    for (const text of line.split(/\s+/).filter((part) => part !== '')) {
      words.push({ text, tokens: Math.max(1, estimateTokens(text)), section });
    }
  }
  return words;
}
