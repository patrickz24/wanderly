import { estimateTokens, type TokenEstimator } from './tokens.js';

/**
 * Structure-aware Markdown chunker (plan section 6, option 3).
 *
 * 1. The document is cut into sections at `##` and `###` headings. Deeper headings stay inside
 *    their section, glued to the block that follows them.
 * 2. Sections smaller than `minTokens` are merged with an adjacent sibling (same parent heading)
 *    when the result still fits `targetTokens`, so a three-line subsection does not become a
 *    low-information chunk of its own.
 * 3. Sections longer than `maxTokens` are split on block boundaries (paragraphs, list items,
 *    quotes) towards `targetTokens`, each part repeating up to `overlapTokens` of the previous
 *    part. A list item (a Wikivoyage listing) is never cut, even when it alone exceeds the
 *    budget; an over-long paragraph is split between sentences.
 * 4. Each chunk carries its breadcrumb, "<Document title> > <Section> > <Subsection>", which is
 *    prefixed to the embedded text when `contextualHeader` is on (contextual chunk header).
 *
 * Budgets apply to the chunk body and are counted with a token estimate (see `tokens.ts`).
 */

export interface ChunkingOptions {
  /** Size, in estimated tokens, that long sections are split towards. */
  readonly targetTokens: number;
  /** A section up to this size stays whole; parts never exceed it, except one over-long list item. */
  readonly maxTokens: number;
  /** Trailing context of a part repeated at the start of the next part of the same section. */
  readonly overlapTokens: number;
  /** Sections below this size are merged with a sibling when the result fits `targetTokens`. */
  readonly minTokens: number;
  /** Prefix the breadcrumb to the embedded text. */
  readonly contextualHeader: boolean;
}

/** Bump when the algorithm changes, so that ingestion re-chunks every document. */
export const CHUNKER_VERSION = 1;

/**
 * Default parameters. In the retrieval evaluation (docs/EVALUATIONS.md) this configuration beats
 * a fixed-size baseline by 10.4 points of Recall@5 with vector search (95 % CI 2.8 to 18.9); other
 * sizes have not been compared yet. Bodies stay under ~450 estimated tokens so that, with the
 * breadcrumb, the embedded text fits the model's 512-token window (2 of 2,136 chunks exceed it).
 */
export const DEFAULT_CHUNKING: ChunkingOptions = {
  targetTokens: 300,
  maxTokens: 450,
  overlapTokens: 30,
  minTokens: 60,
  contextualHeader: true,
};

export const BREADCRUMB_SEPARATOR = ' > ';

export interface MarkdownDocument {
  /** Breadcrumb root, usually the document title. */
  readonly title: string;
  /** Markdown body, front matter removed. A leading `# Title` heading is skipped. */
  readonly markdown: string;
}

export interface Chunk {
  /** 0-based position in the document. */
  readonly ordinal: number;
  /** Breadcrumb of the chunk, e.g. "Sicily > Do > Hiking" (the common parent for merged sections). */
  readonly headingPath: string;
  /** Every section the chunk covers, relative to the document ("Do > Hiking"; "" = before any heading). */
  readonly sections: readonly string[];
  /** Markdown body shown to the agent (no breadcrumb). */
  readonly content: string;
  /** Text to embed: breadcrumb + body when `contextualHeader` is on, the body otherwise. */
  readonly text: string;
  /** Estimated tokens of `text`. */
  readonly tokenCount: number;
}

type BlockKind = 'paragraph' | 'item' | 'quote' | 'code' | 'heading';

interface Block {
  readonly kind: BlockKind;
  readonly text: string;
  readonly tokens: number;
}

interface Section {
  readonly path: readonly string[];
  readonly blocks: readonly Block[];
}

/** A section, or several small sibling sections merged together. */
interface Unit {
  readonly path: readonly string[];
  readonly sections: ReadonlyArray<readonly string[]>;
  readonly blocks: readonly Block[];
  readonly tokens: number;
}

interface Part {
  readonly blocks: readonly Block[];
  readonly tokens: number;
  /** Leading blocks repeated from the previous part. */
  readonly overlap: number;
}

export function validateChunkingOptions(options: ChunkingOptions): ChunkingOptions {
  const { targetTokens, maxTokens, overlapTokens, minTokens } = options;
  const integers = { targetTokens, maxTokens, overlapTokens, minTokens };
  for (const [name, value] of Object.entries(integers)) {
    if (!Number.isInteger(value) || value < 0) {
      throw new RangeError(`${name} must be a non-negative integer (got ${value})`);
    }
  }
  if (targetTokens < 1) throw new RangeError('targetTokens must be at least 1');
  if (maxTokens < targetTokens) throw new RangeError('maxTokens must be >= targetTokens');
  if (overlapTokens >= targetTokens) throw new RangeError('overlapTokens must be < targetTokens');
  if (minTokens > targetTokens) throw new RangeError('minTokens must be <= targetTokens');
  return options;
}

/** Stable description of the chunking configuration, stored with each indexed document. */
export function chunkingFingerprint(options: ChunkingOptions): string {
  const { targetTokens, maxTokens, overlapTokens, minTokens, contextualHeader } = options;
  return [
    `md-v${CHUNKER_VERSION}`,
    `target=${targetTokens}`,
    `max=${maxTokens}`,
    `overlap=${overlapTokens}`,
    `min=${minTokens}`,
    `header=${contextualHeader ? 'on' : 'off'}`,
  ].join(';');
}

/** A chunking strategy, identified by a fingerprint stored with each indexed document. */
export interface DocumentChunker {
  readonly fingerprint: string;
  chunk(document: MarkdownDocument): Chunk[];
}

/** The structure-aware chunker below, with fixed parameters. */
export function markdownChunker(
  options: ChunkingOptions,
  estimate: TokenEstimator = estimateTokens,
): DocumentChunker {
  validateChunkingOptions(options);
  return {
    fingerprint: chunkingFingerprint(options),
    chunk: (document) => chunkMarkdown(document, options, estimate),
  };
}

export function chunkMarkdown(
  document: MarkdownDocument,
  options: ChunkingOptions,
  estimate: TokenEstimator = estimateTokens,
): Chunk[] {
  validateChunkingOptions(options);
  const sections = parseSections(document.markdown, estimate);
  const units = mergeSmallSiblings(
    sections.map((section) => toUnit(section)),
    options,
    estimate,
  );

  const chunks: Chunk[] = [];
  for (const unit of units) {
    for (const part of splitUnit(unit, options, estimate)) {
      const headingPath = [document.title, ...unit.path].join(BREADCRUMB_SEPARATOR);
      const content = joinBlocks(part.blocks);
      const text = options.contextualHeader ? `${headingPath}\n\n${content}` : content;
      chunks.push({
        ordinal: chunks.length,
        headingPath,
        sections: unit.sections.map((path) => path.join(BREADCRUMB_SEPARATOR)),
        content,
        text,
        tokenCount: estimate(text),
      });
    }
  }
  return chunks;
}

// ---------------------------------------------------------------------------------------------
// Parsing: Markdown → sections of blocks
// ---------------------------------------------------------------------------------------------

const HEADING = /^(#{1,6})[ \t]+(.*?)[ \t]*#*[ \t]*$/;
const FENCE = /^[ \t]{0,3}(```|~~~)/;
const TOP_LEVEL_ITEM = /^ ?(?:[-*+]|\d{1,9}[.)])[ \t]+\S/;
const QUOTE = /^[ \t]{0,3}>/;

function parseSections(markdown: string, estimate: TokenEstimator): Section[] {
  const lines = markdown.replace(/\r\n?/g, '\n').split('\n');
  const sections: Section[] = [];
  let path: string[] = [];
  let currentH2: string | null = null;
  let buffer: string[] = [];
  let seenTitle = false;

  const flush = (): void => {
    const blocks = toBlocks(buffer, estimate);
    if (blocks.length > 0) sections.push({ path, blocks });
    buffer = [];
  };

  let inFence = false;
  for (const line of lines) {
    if (FENCE.test(line)) inFence = !inFence;
    const heading = inFence ? null : HEADING.exec(line);
    const level = heading?.[1]?.length ?? 0;
    const title = heading?.[2]?.trim() ?? '';

    if (heading === null || level >= 4 || title === '') {
      buffer.push(line);
    } else if (level === 1 && !seenTitle && sections.length === 0 && isBlank(buffer)) {
      seenTitle = true; // the document title is the breadcrumb root, not a section
    } else if (level <= 2) {
      flush();
      currentH2 = title;
      path = [title];
    } else {
      flush();
      path = currentH2 === null ? [title] : [currentH2, title];
    }
  }
  flush();
  return sections;
}

function isBlank(lines: readonly string[]): boolean {
  return lines.every((line) => line.trim() === '');
}

/** Groups lines into blocks: paragraphs, top-level list items (with continuations), quotes, code. */
function toBlocks(lines: readonly string[], estimate: TokenEstimator): Block[] {
  const raw: Array<{ kind: BlockKind; lines: string[] }> = [];
  let current: { kind: BlockKind; lines: string[] } | null = null;
  let inFence = false;

  const close = (): void => {
    if (current !== null) raw.push(current);
    current = null;
  };

  for (const line of lines) {
    if (inFence) {
      current?.lines.push(line);
      if (FENCE.test(line)) {
        inFence = false;
        close();
      }
      continue;
    }
    if (FENCE.test(line)) {
      close();
      current = { kind: 'code', lines: [line] };
      inFence = true;
      continue;
    }
    if (line.trim() === '') {
      close();
      continue;
    }
    const heading = HEADING.exec(line);
    if (heading !== null) {
      close();
      raw.push({ kind: 'heading', lines: [line.trim()] });
      continue;
    }
    const kind: BlockKind = TOP_LEVEL_ITEM.test(line)
      ? 'item'
      : QUOTE.test(line)
        ? 'quote'
        : 'paragraph';
    const continues =
      current !== null && (kind === 'paragraph' || (kind === 'quote' && current.kind === 'quote'));
    if (continues && current !== null) {
      current.lines.push(line);
    } else {
      close();
      current = { kind, lines: [line] };
    }
  }
  close();

  // A heading inside a section is glued to the block that follows it, never left alone at the
  // end of a part; a trailing heading with nothing after it stays a block of its own.
  const blocks: Block[] = [];
  let pendingHeadings: string[] = [];
  for (const block of raw) {
    if (block.kind === 'heading') {
      pendingHeadings.push(...block.lines);
      continue;
    }
    const text = [...pendingHeadings, block.lines.join('\n').trimEnd()].join('\n');
    pendingHeadings = [];
    blocks.push({ kind: block.kind, text, tokens: estimate(text) });
  }
  if (pendingHeadings.length > 0) {
    const text = pendingHeadings.join('\n');
    blocks.push({ kind: 'paragraph', text, tokens: estimate(text) });
  }
  return blocks;
}

// ---------------------------------------------------------------------------------------------
// Merging small sibling sections
// ---------------------------------------------------------------------------------------------

function toUnit(section: Section): Unit {
  return {
    path: section.path,
    sections: [section.path],
    blocks: section.blocks,
    tokens: sumTokens(section.blocks),
  };
}

/**
 * Two units are siblings when they belong to the same `##` section (its introduction and its
 * `###` subsections), or when both are top-level `##` sections without subsections.
 */
function areSiblings(left: Unit, right: Unit): boolean {
  const all = [...left.sections, ...right.sections];
  const first = all[0]?.[0];
  if (all.every((path) => path.length >= 1 && path[0] === first)) return true;
  return all.every((path) => path.length === 1);
}

function mergeSmallSiblings(
  units: readonly Unit[],
  options: ChunkingOptions,
  estimate: TokenEstimator,
): Unit[] {
  const merged: Unit[] = [];
  for (const unit of units) {
    const previous = merged.at(-1);
    const small = (candidate: Unit): boolean => candidate.tokens < options.minTokens;
    if (previous !== undefined && (small(previous) || small(unit)) && areSiblings(previous, unit)) {
      const candidate = mergeUnits(previous, unit, estimate);
      if (candidate.tokens <= options.targetTokens) {
        merged[merged.length - 1] = candidate;
        continue;
      }
    }
    merged.push(unit);
  }
  return merged;
}

function mergeUnits(left: Unit, right: Unit, estimate: TokenEstimator): Unit {
  const path = commonPrefix(left.path, right.path);
  const blocks = [...withHeading(left, path, estimate), ...withHeading(right, path, estimate)];
  return {
    path,
    sections: [...left.sections, ...right.sections],
    blocks,
    tokens: sumTokens(blocks),
  };
}

/** Prefixes a unit's blocks with its own heading when it moves under a shorter path. */
function withHeading(unit: Unit, path: readonly string[], estimate: TokenEstimator): Block[] {
  if (unit.path.length <= path.length) return [...unit.blocks];
  const headings = unit.path
    .slice(path.length)
    .map((title, index) => `${'#'.repeat(path.length + index + 2)} ${title}`);
  const [first, ...rest] = unit.blocks;
  if (first === undefined) return [];
  const text = [...headings, first.text].join('\n');
  return [{ ...first, text, tokens: estimate(text) }, ...rest];
}

function commonPrefix(left: readonly string[], right: readonly string[]): string[] {
  const prefix: string[] = [];
  for (let index = 0; index < Math.min(left.length, right.length); index++) {
    if (left[index] !== right[index]) break;
    prefix.push(left[index] as string);
  }
  return prefix;
}

// ---------------------------------------------------------------------------------------------
// Splitting long sections
// ---------------------------------------------------------------------------------------------

function splitUnit(unit: Unit, options: ChunkingOptions, estimate: TokenEstimator): Part[] {
  if (unit.tokens <= options.maxTokens) {
    return [{ blocks: unit.blocks, tokens: unit.tokens, overlap: 0 }];
  }

  const blocks = unit.blocks.flatMap((block) =>
    block.tokens > options.maxTokens && (block.kind === 'paragraph' || block.kind === 'quote')
      ? splitParagraph(block, options.targetTokens, estimate)
      : [block],
  );

  const parts: Part[] = [];
  let current: Block[] = [];
  let currentTokens = 0;
  let overlapCount = 0;

  for (const block of blocks) {
    const hasFreshBlocks = current.length > overlapCount;
    if (hasFreshBlocks && currentTokens + block.tokens > options.targetTokens) {
      parts.push({ blocks: current, tokens: currentTokens, overlap: overlapCount });
      const overlap = overlapFrom(current, options.overlapTokens, estimate);
      current = sumTokens(overlap) + block.tokens <= options.maxTokens ? overlap : [];
      currentTokens = sumTokens(current);
      overlapCount = current.length;
    }
    current.push(block);
    currentTokens += block.tokens;
  }
  parts.push({ blocks: current, tokens: currentTokens, overlap: overlapCount });

  return absorbSmallTail(parts, options);
}

/** A tiny last part is folded into the previous one (without its overlap) when that fits. */
function absorbSmallTail(parts: readonly Part[], options: ChunkingOptions): Part[] {
  const last = parts.at(-1);
  const previous = parts.at(-2);
  if (last === undefined || previous === undefined) return [...parts];
  const fresh = last.blocks.slice(last.overlap);
  const freshTokens = sumTokens(fresh);
  if (freshTokens >= options.minTokens || previous.tokens + freshTokens > options.maxTokens) {
    return [...parts];
  }
  const blocks = [...previous.blocks, ...fresh];
  return [...parts.slice(0, -2), { blocks, tokens: sumTokens(blocks), overlap: previous.overlap }];
}

/** Whole trailing blocks within the budget; for a long trailing paragraph, its last sentences. */
function overlapFrom(blocks: readonly Block[], budget: number, estimate: TokenEstimator): Block[] {
  if (budget <= 0) return [];
  const overlap: Block[] = [];
  let used = 0;
  for (let index = blocks.length - 1; index >= 0; index--) {
    const block = blocks[index] as Block;
    if (used + block.tokens <= budget) {
      overlap.unshift(block);
      used += block.tokens;
      continue;
    }
    if (overlap.length === 0 && block.kind === 'paragraph') {
      const tail = trailingSentences(block.text, budget, estimate);
      if (tail !== '') overlap.unshift({ kind: 'paragraph', text: tail, tokens: estimate(tail) });
    }
    break;
  }
  return overlap;
}

const SENTENCE_BOUNDARY = /(?<=[.!?…])\s+(?=["'“‘([]?[\p{Lu}\p{N}])/u;

export function splitSentences(text: string): string[] {
  return text
    .split(SENTENCE_BOUNDARY)
    .map((sentence) => sentence.trim())
    .filter((sentence) => sentence !== '');
}

function trailingSentences(text: string, budget: number, estimate: TokenEstimator): string {
  const sentences = splitSentences(text);
  const kept: string[] = [];
  let used = 0;
  for (let index = sentences.length - 1; index >= 0; index--) {
    const sentence = sentences[index] as string;
    const tokens = estimate(sentence);
    if (used + tokens > budget) break;
    kept.unshift(sentence);
    used += tokens;
  }
  return kept.join(' ');
}

/** Splits an over-long paragraph between sentences into pieces of about `target` tokens. */
function splitParagraph(block: Block, target: number, estimate: TokenEstimator): Block[] {
  const pieces: Block[] = [];
  let current: string[] = [];
  let tokens = 0;
  for (const sentence of splitSentences(block.text)) {
    const sentenceTokens = estimate(sentence);
    if (current.length > 0 && tokens + sentenceTokens > target) {
      const text = current.join(' ');
      pieces.push({ kind: block.kind, text, tokens: estimate(text) });
      current = [];
      tokens = 0;
    }
    current.push(sentence);
    tokens += sentenceTokens;
  }
  if (current.length > 0) {
    const text = current.join(' ');
    pieces.push({ kind: block.kind, text, tokens: estimate(text) });
  }
  return pieces;
}

// ---------------------------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------------------------

function sumTokens(blocks: readonly Block[]): number {
  return blocks.reduce((total, block) => total + block.tokens, 0);
}

/** Consecutive list items stay one list; other blocks are separate paragraphs. */
function joinBlocks(blocks: readonly Block[]): string {
  let text = '';
  blocks.forEach((block, index) => {
    const previous = blocks[index - 1];
    if (previous !== undefined) {
      text += previous.kind === 'item' && block.kind === 'item' ? '\n' : '\n\n';
    }
    text += block.text;
  });
  return text;
}
