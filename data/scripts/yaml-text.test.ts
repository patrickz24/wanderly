import { describe, expect, it } from 'vitest';
import { parse } from 'yaml';
import { parseFrontMatter, withFrontMatter } from './front-matter.js';
import { stringifyYaml } from './yaml-text.js';

describe('stringifyYaml', () => {
  it('quotes dates, timestamps and YAML 1.1 booleans so that every parser reads strings', () => {
    const text = stringifyYaml({
      start: '2015-01-01',
      at: '2026-07-31T17:00:44Z',
      answer: 'no',
      title: 'Sicily',
    });
    expect(text).toBe(
      "start: '2015-01-01'\nat: '2026-07-31T17:00:44Z'\nanswer: 'no'\ntitle: Sicily\n",
    );
  });

  it('does not fold long lines', () => {
    const long = 'word '.repeat(40).trim();
    expect(stringifyYaml({ long })).toBe(`long: ${long}\n`);
  });
});

describe('front matter', () => {
  it('round-trips data and body', () => {
    const text = withFrontMatter({ id: 'sicily', revision_id: 1 }, '# Sicily\n');
    expect(text).toBe('---\nid: sicily\nrevision_id: 1\n---\n\n# Sicily\n');
    expect(parseFrontMatter(text)).toEqual({
      data: { id: 'sicily', revision_id: 1 },
      body: '\n# Sicily\n',
    });
    expect(parse('a: 1')).toEqual({ a: 1 });
  });

  it('fails without front matter', () => {
    expect(() => parseFrontMatter('# Title')).toThrow(/front matter/);
  });
});
