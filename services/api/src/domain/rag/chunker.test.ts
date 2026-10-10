import { describe, expect, it } from 'vitest';
import {
  chunkMarkdown,
  chunkingFingerprint,
  splitSentences,
  validateChunkingOptions,
  type ChunkingOptions,
} from './chunker.js';

/** One token per whitespace-separated word: budgets in tests are easy to reason about. */
const words = (text: string): number => text.split(/\s+/).filter((word) => word !== '').length;

const OPTIONS: ChunkingOptions = {
  targetTokens: 40,
  maxTokens: 60,
  overlapTokens: 0,
  minTokens: 10,
  contextualHeader: true,
};

const lorem = (count: number, word = 'word'): string =>
  Array.from({ length: count }, (_, index) => `${word}${index}`).join(' ');

function chunk(markdown: string, options: Partial<ChunkingOptions> = {}, title = 'Sicily') {
  return chunkMarkdown({ title, markdown }, { ...OPTIONS, ...options }, words);
}

describe('chunkMarkdown: one chunk per section', () => {
  it('cuts at ## and ### headings and builds the breadcrumb from the document title', () => {
    const markdown = [
      '# Sicily',
      '',
      '## See',
      '',
      lorem(12, 'see'),
      '',
      '### Museums',
      '',
      lorem(15, 'museum'),
      '',
      '## Do',
      '',
      '### Hiking',
      '',
      lorem(20, 'hike'),
    ].join('\n');

    const chunks = chunk(markdown);

    expect(chunks.map((c) => c.headingPath)).toEqual([
      'Sicily > See',
      'Sicily > See > Museums',
      'Sicily > Do > Hiking',
    ]);
    expect(chunks.map((c) => c.sections)).toEqual([['See'], ['See > Museums'], ['Do > Hiking']]);
    expect(chunks.map((c) => c.ordinal)).toEqual([0, 1, 2]);
    expect(chunks[2]?.content).toBe(lorem(20, 'hike'));
  });

  it('prefixes the breadcrumb to the embedded text only when the contextual header is on', () => {
    const markdown = `## Do\n\n### Hiking\n\n${lorem(20)}`;

    const [withHeader] = chunk(markdown, { contextualHeader: true });
    const [withoutHeader] = chunk(markdown, { contextualHeader: false });

    expect(withHeader?.text).toBe(`Sicily > Do > Hiking\n\n${lorem(20)}`);
    expect(withHeader?.tokenCount).toBe(20 + 5);
    expect(withoutHeader?.text).toBe(lorem(20));
    expect(withoutHeader?.tokenCount).toBe(20);
    expect(withoutHeader?.headingPath).toBe('Sicily > Do > Hiking');
  });

  it('keeps text before the first section under the document root', () => {
    const chunks = chunk(`# Sicily\n\n${lorem(15)}\n\n## See\n\n${lorem(15)}`);

    expect(chunks.map((c) => c.headingPath)).toEqual(['Sicily', 'Sicily > See']);
    expect(chunks[0]?.sections).toEqual(['']);
  });

  it('skips headings that only introduce subsections', () => {
    const chunks = chunk(
      `## Get in\n\n### By plane\n\n${lorem(15)}\n\n### By boat\n\n${lorem(15)}`,
    );

    expect(chunks.map((c) => c.headingPath)).toEqual([
      'Sicily > Get in > By plane',
      'Sicily > Get in > By boat',
    ]);
  });

  it('keeps #### headings inside their section, glued to the following block', () => {
    const markdown = `## Eat\n\n#### Bread\n\n${lorem(15)}\n\n#### Cheese\n\n${lorem(15)}`;

    const [only, ...rest] = chunk(markdown);

    expect(rest).toEqual([]);
    expect(only?.headingPath).toBe('Sicily > Eat');
    expect(only?.content).toBe(`#### Bread\n${lorem(15)}\n\n#### Cheese\n${lorem(15)}`);
  });

  it('treats a ### before any ## as a top-level section and later # headings as sections', () => {
    const chunks = chunk(`### Orphan\n\n${lorem(15)}\n\n# Appendix\n\n${lorem(15)}`);

    expect(chunks.map((c) => c.headingPath)).toEqual(['Sicily > Orphan', 'Sicily > Appendix']);
  });

  it('ignores headings inside fenced code blocks and never splits the block', () => {
    const code = ['```', '## not a heading', lorem(5), '```'].join('\n');
    const chunks = chunk(`## Talk\n\n${code}\n\n${lorem(15)}`);

    expect(chunks).toHaveLength(1);
    expect(chunks[0]?.content).toBe(`${code}\n\n${lorem(15)}`);
  });

  it('returns no chunk for an empty or heading-only document', () => {
    expect(chunk('')).toEqual([]);
    expect(chunk('# Sicily\n\n## See\n\n### Museums\n')).toEqual([]);
  });

  it('accepts Windows line endings and closing hashes', () => {
    const chunks = chunk(`## See ##\r\n\r\n${lorem(15)}\r\n`);

    expect(chunks.map((c) => c.headingPath)).toEqual(['Sicily > See']);
    expect(chunks[0]?.content).toBe(lorem(15));
  });
});

describe('chunkMarkdown: merging small sections', () => {
  it('merges a small section into its next sibling, keeping its heading in the content', () => {
    const markdown = `## Do\n\n### Fishing\n\n${lorem(5, 'fish')}\n\n### Cycling\n\n${lorem(20, 'bike')}`;

    const chunks = chunk(markdown);

    expect(chunks).toHaveLength(1);
    expect(chunks[0]?.headingPath).toBe('Sicily > Do');
    expect(chunks[0]?.sections).toEqual(['Do > Fishing', 'Do > Cycling']);
    expect(chunks[0]?.content).toBe(
      `### Fishing\n${lorem(5, 'fish')}\n\n### Cycling\n${lorem(20, 'bike')}`,
    );
  });

  it('merges a section introduction with its first subsection', () => {
    const chunks = chunk(`## See\n\nSicily has sights.\n\n### Museums\n\n${lorem(20)}`);

    expect(chunks).toHaveLength(1);
    expect(chunks[0]?.headingPath).toBe('Sicily > See');
    expect(chunks[0]?.sections).toEqual(['See', 'See > Museums']);
    expect(chunks[0]?.content).toBe(`Sicily has sights.\n\n### Museums\n${lorem(20)}`);
  });

  it('merges small top-level sections without subsections under the document root', () => {
    const chunks = chunk(`## Respect\n\n${lorem(4)}\n\n## Go next\n\n${lorem(6)}`);

    expect(chunks).toHaveLength(1);
    expect(chunks[0]?.headingPath).toBe('Sicily');
    expect(chunks[0]?.content).toBe(`## Respect\n${lorem(4)}\n\n## Go next\n${lorem(6)}`);
  });

  it('never merges across different ## sections', () => {
    const markdown = `## See\n\n### Museums\n\n${lorem(20)}\n\n## Do\n\n### Fishing\n\n${lorem(5)}`;

    const chunks = chunk(markdown);

    expect(chunks.map((c) => c.headingPath)).toEqual([
      'Sicily > See > Museums',
      'Sicily > Do > Fishing',
    ]);
  });

  it('does not merge when the result would exceed the target size', () => {
    const markdown = `## Do\n\n### Fishing\n\n${lorem(5)}\n\n### Cycling\n\n${lorem(38)}`;

    const chunks = chunk(markdown);

    expect(chunks.map((c) => c.headingPath)).toEqual([
      'Sicily > Do > Fishing',
      'Sicily > Do > Cycling',
    ]);
  });

  it('keeps chaining small siblings while they fit', () => {
    const markdown = ['## Do', '### A', lorem(5), '### B', lorem(5), '### C', lorem(5)].join(
      '\n\n',
    );

    const chunks = chunk(markdown);

    expect(chunks).toHaveLength(1);
    expect(chunks[0]?.sections).toEqual(['Do > A', 'Do > B', 'Do > C']);
  });

  it('leaves sections alone when minTokens is 0', () => {
    const markdown = `## Do\n\n### Fishing\n\n${lorem(5)}\n\n### Cycling\n\n${lorem(5)}`;

    expect(chunk(markdown, { minTokens: 0 })).toHaveLength(2);
  });
});

describe('chunkMarkdown: splitting long sections', () => {
  const items = (count: number, size: number): string[] =>
    Array.from({ length: count }, (_, index) => `- **Place ${index}** — ${lorem(size - 4)}`);

  it('keeps a section whole up to maxTokens', () => {
    const chunks = chunk(`## See\n\n${lorem(30)}\n\n${lorem(30)}`);

    expect(chunks).toHaveLength(1);
  });

  it('splits a long list between items, towards the target size, never inside an item', () => {
    const list = items(8, 15); // 120 tokens, 15 per item
    const chunks = chunk(`## Sleep\n\n${list.join('\n')}`);

    expect(chunks.length).toBeGreaterThan(1);
    for (const piece of chunks) {
      expect(words(piece.content)).toBeLessThanOrEqual(OPTIONS.targetTokens);
      expect(piece.headingPath).toBe('Sicily > Sleep');
      for (const line of piece.content.split('\n')) expect(list).toContain(line);
    }
    expect(chunks.map((c) => c.content).join('\n')).toBe(list.join('\n'));
  });

  it('keeps an over-long list item whole, alone in its chunk', () => {
    const [long] = items(1, 90);
    const list = [...items(2, 10), long as string, ...items(2, 10)];

    const chunks = chunk(`## Sleep\n\n${list.join('\n')}`);

    const oversized = chunks.filter((c) => c.content.includes(long as string));
    expect(oversized).toHaveLength(1);
    expect(oversized[0]?.content).toBe(long);
  });

  it('splits an over-long paragraph between sentences', () => {
    const sentence = (index: number) => `Sentence ${index} ${lorem(8)}.`; // 10 words
    const paragraph = Array.from({ length: 10 }, (_, index) => sentence(index)).join(' ');

    const chunks = chunk(`## Understand\n\n${paragraph}`);

    expect(chunks.length).toBeGreaterThan(1);
    for (const piece of chunks) {
      expect(words(piece.content)).toBeLessThanOrEqual(OPTIONS.maxTokens);
      expect(piece.content.startsWith('Sentence ')).toBe(true);
      expect(piece.content.endsWith('.')).toBe(true);
    }
  });

  it('repeats whole trailing blocks of the previous part as overlap', () => {
    const list = items(8, 15);

    const chunks = chunk(`## Sleep\n\n${list.join('\n')}`, { overlapTokens: 15 });

    for (let index = 1; index < chunks.length; index++) {
      const previousLines = (chunks[index - 1]?.content ?? '').split('\n');
      const firstLine = (chunks[index]?.content ?? '').split('\n')[0];
      expect(firstLine).toBe(previousLines.at(-1));
    }
  });

  it('uses the last sentences of a long paragraph as overlap', () => {
    const paragraphs = [
      `First ${lorem(10)}. Second ${lorem(10)}. Third ${lorem(10)}.`,
      `Next ${lorem(30)}.`,
      `Final ${lorem(30)}.`,
    ];

    const chunks = chunk(`## Understand\n\n${paragraphs.join('\n\n')}`, { overlapTokens: 12 });

    expect(chunks[1]?.content.startsWith(`Third ${lorem(10)}.\n\nNext`)).toBe(true);
  });

  it('drops the overlap when it would push a part over maxTokens', () => {
    const list = [...items(1, 30), ...items(1, 55)];

    const chunks = chunk(`## Sleep\n\n${list.join('\n')}`, { overlapTokens: 30 });

    expect(chunks.map((c) => c.content)).toEqual(list);
  });

  // 85 tokens: parts of 40 + 40 + a 5-token tail.
  const withTail = [...items(4, 20), ...items(1, 5)];

  it('folds a tiny last part into the previous one when it fits', () => {
    const chunks = chunk(`## Sleep\n\n${withTail.join('\n')}`, { maxTokens: 60, minTokens: 10 });

    expect(chunks.map((c) => words(c.content))).toEqual([40, 45]);
    expect(chunks.map((c) => c.content).join('\n')).toBe(withTail.join('\n'));
  });

  it('keeps a small last part separate when folding it would exceed maxTokens', () => {
    const chunks = chunk(`## Sleep\n\n${withTail.join('\n')}`, { maxTokens: 44, minTokens: 10 });

    expect(chunks.map((c) => words(c.content))).toEqual([40, 40, 5]);
  });

  it('folds the tail without repeating the overlap', () => {
    const chunks = chunk(`## Sleep\n\n${withTail.join('\n')}`, {
      maxTokens: 60,
      minTokens: 10,
      overlapTokens: 20,
    });

    const last = chunks.at(-1)?.content.split('\n') ?? [];
    expect(new Set(last).size).toBe(last.length);
    expect(last.at(-1)).toBe(withTail.at(-1));
  });

  it('keeps list continuation lines and nested items with their item', () => {
    const item = ['- **Etna** — volcano', '  - summit tours', '  continued text'].join('\n');
    const chunks = chunk(`## See\n\n${item}\n- **Other** — ${lorem(12)}`);

    expect(chunks[0]?.content.split('\n- ')[0]).toBe(item);
  });

  it('separates quotes and paragraphs written without a blank line', () => {
    const chunks = chunk(`## Stay safe\n\n${lorem(6)}\n> **Warning:** ${lorem(6)}\n> more`, {
      minTokens: 0,
    });

    expect(chunks[0]?.content).toBe(`${lorem(6)}\n\n> **Warning:** ${lorem(6)}\n> more`);
  });
});

describe('chunkMarkdown with the default token estimator', () => {
  it('counts tokens with the calibrated estimate', () => {
    const chunks = chunkMarkdown(
      { title: 'Sicily', markdown: '## Do\n\nHiking on Etna.' },
      { ...OPTIONS, contextualHeader: false },
    );

    expect(chunks[0]?.tokenCount).toBe(4);
  });
});

describe('validateChunkingOptions', () => {
  it.each([
    [{ targetTokens: 0 }, 'targetTokens must be at least 1'],
    [{ maxTokens: 39 }, 'maxTokens must be >= targetTokens'],
    [{ overlapTokens: 40 }, 'overlapTokens must be < targetTokens'],
    [{ minTokens: 41 }, 'minTokens must be <= targetTokens'],
    [{ minTokens: -1 }, 'minTokens must be a non-negative integer'],
    [{ targetTokens: 1.5 }, 'targetTokens must be a non-negative integer'],
  ])('rejects %o', (override, message) => {
    expect(() => validateChunkingOptions({ ...OPTIONS, ...override })).toThrow(message);
    expect(() => chunkMarkdown({ title: 'T', markdown: '' }, { ...OPTIONS, ...override })).toThrow(
      RangeError,
    );
  });

  it('accepts consistent options', () => {
    expect(validateChunkingOptions(OPTIONS)).toBe(OPTIONS);
  });
});

describe('chunkingFingerprint', () => {
  it('describes every parameter and the algorithm version', () => {
    expect(chunkingFingerprint(OPTIONS)).toBe('md-v1;target=40;max=60;overlap=0;min=10;header=on');
    expect(chunkingFingerprint({ ...OPTIONS, contextualHeader: false })).toContain('header=off');
  });
});

describe('splitSentences', () => {
  it('splits after sentence punctuation followed by a capital or a digit', () => {
    expect(splitSentences('Go early. It is busy! Really? 3 buses run. done')).toEqual([
      'Go early.',
      'It is busy!',
      'Really?',
      '3 buses run. done',
    ]);
  });

  it('returns nothing for blank text', () => {
    expect(splitSentences('   ')).toEqual([]);
  });
});
