import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { stringify } from 'yaml';
import { CorpusValidationError } from '../../application/ports/corpus-source.js';
import { DEFAULT_CORPUS_DIR, FsCorpusSource } from './fs-corpus-source.js';

const REVISION = 5320270;

function frontMatter(overrides: Record<string, unknown> = {}): string {
  const fields = {
    id: 'sicily',
    title: 'Sicily',
    source_url: 'https://en.wikivoyage.org/wiki/Sicily',
    revision_id: REVISION,
    revision_timestamp: '2026-07-31T17:00:44Z',
    revision_url: `https://en.wikivoyage.org/w/index.php?title=Sicily&oldid=${REVISION}`,
    retrieved_at: '2026-10-09T13:36:51.611Z',
    license: 'CC BY-SA 4.0',
    license_url: 'https://creativecommons.org/licenses/by-sa/4.0/deed.en',
    attribution: '"Sicily" by Wikivoyage contributors',
    is_part_of: ['Italy'],
    ...overrides,
  };
  return `---\n${stringify(fields)}---\n`;
}

const month = (index: number) => ({
  month: index + 1,
  avg_high_c: 20,
  avg_low_c: 10,
  rain_days: 5,
  precipitation_mm: 40,
});
const emptyLevel = { lodging_night: null, meal: null, notes: ['no priced listing'] };

function facts(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    schema_version: 1,
    id: 'sicily',
    name: 'Sicily',
    country: 'Italy',
    aliases: ['Sicilia'],
    is_part_of: ['Italy'],
    source: {
      guide: 'guide.md',
      title: 'Sicily',
      url: 'https://en.wikivoyage.org/wiki/Sicily',
      revision_id: REVISION,
      license: 'CC BY-SA 4.0',
    },
    climate: {
      provider: 'Open-Meteo',
      model: 'era5_seamless',
      period: { start: '2015-01-01', end: '2024-12-31' },
      point: { lat: 38.1, lon: 13.4, source: 'Palermo' },
      grid_cell: { lat: 38.1, lon: 13.4, elevation_m: 20 },
      license: 'CC BY 4.0',
      attribution: 'Weather data by Open-Meteo.com',
      months: Array.from({ length: 12 }, (_, index) => month(index)),
    },
    costs: {
      derivation: 'listing prices',
      overall: emptyLevel,
      levels: { budget: emptyLevel, mid: emptyLevel, comfort: emptyLevel },
    },
    pois: [],
    extraction: {
      listings: 0,
      listings_by_type: {},
      priced_listings: { sleep: 0, eat: 0 },
      poi_sources: { listing: 0, marker: 0, named: 0 },
      duplicate_pois_dropped: 0,
    },
    ...overrides,
  };
}

const GUIDE_BODY = '# Sicily\n\n## Do\n\n### Hiking\n\nMount Etna offers volcanic hikes.\n';

let root: string;

beforeEach(async () => {
  root = await mkdtemp(path.join(tmpdir(), 'wanderly-corpus-'));
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

async function write(file: string, content: string): Promise<void> {
  await mkdir(path.dirname(path.join(root, file)), { recursive: true });
  await writeFile(path.join(root, file), content, 'utf8');
}

async function writeSicily(
  options: { places?: boolean; factsOverrides?: Record<string, unknown> } = {},
) {
  await write('sicily/facts.yaml', stringify(facts(options.factsOverrides)));
  await write('sicily/guide.md', frontMatter() + GUIDE_BODY);
  if (options.places) {
    await write(
      'sicily/places/palermo.md',
      frontMatter({ id: 'palermo', title: 'Palermo', parent: 'sicily' }) +
        '# Palermo\n\n## See\n\nMarkets.\n',
    );
  }
}

async function loadIssues(): Promise<readonly string[]> {
  const error = await new FsCorpusSource(root).load().catch((caught: unknown) => caught);
  expect(error).toBeInstanceOf(CorpusValidationError);
  return (error as CorpusValidationError).issues;
}

describe('FsCorpusSource', () => {
  it('reads and validates a destination with its region guide', async () => {
    await writeSicily();
    await write('ATTRIBUTION.md', '# ignored file at the root');

    const corpus = await new FsCorpusSource(root).load();

    expect(corpus.destinations).toHaveLength(1);
    const [sicily] = corpus.destinations;
    expect(sicily?.facts.name).toBe('Sicily');
    expect(sicily?.factsAsOf).toBe('2026-07-31');
    const raw = frontMatter() + GUIDE_BODY;
    expect(sicily?.documents).toEqual([
      {
        path: 'sicily/guide.md',
        destinationId: 'sicily',
        role: 'region',
        title: 'Sicily',
        breadcrumbRoot: 'Sicily',
        sourceUrl: `https://en.wikivoyage.org/w/index.php?title=Sicily&oldid=${REVISION}`,
        license: 'CC BY-SA 4.0',
        attribution: '"Sicily" by Wikivoyage contributors',
        body: GUIDE_BODY.trim(),
        checksum: createHash('sha256').update(raw).digest('hex'),
      },
    ]);
  });

  it('adds place articles after the region guide, with the region in their breadcrumb', async () => {
    await writeSicily({ places: true });

    const corpus = await new FsCorpusSource(root).load();

    const place = corpus.destinations[0]?.documents[1];
    expect(place).toMatchObject({
      path: 'sicily/places/palermo.md',
      role: 'place',
      title: 'Palermo',
      breadcrumbRoot: 'Sicily > Palermo',
      body: '# Palermo\n\n## See\n\nMarkets.',
    });
  });

  it('cross-checks place articles with the documents listed in facts.yaml', async () => {
    const documents = [
      {
        file: 'guide.md',
        role: 'region',
        id: 'sicily',
        title: 'Sicily',
        url: 'https://en.wikivoyage.org/wiki/Sicily',
        revision_id: REVISION,
        license: 'CC BY-SA 4.0',
      },
      {
        file: 'places/catania.md',
        role: 'place',
        id: 'catania',
        title: 'Catania',
        url: 'https://en.wikivoyage.org/wiki/Catania',
        revision_id: 1,
        license: 'CC BY-SA 4.0',
      },
    ];
    await writeSicily({ places: true, factsOverrides: { documents } });

    expect(await loadIssues()).toEqual([
      'sicily/facts.yaml: lists places/catania.md, which is missing',
      'sicily/places/palermo.md: not listed in facts.yaml documents',
    ]);
  });

  it('reports every problem of every file at once', async () => {
    await writeSicily();
    await write('crete/facts.yaml', stringify(facts({ id: 'crete', name: '' })));
    await write('crete/guide.md', 'no front matter');
    await write('malta/facts.yaml', 'key: [unclosed');
    await write('malta/guide.md', frontMatter({ id: 'malta' }));

    const issues = await loadIssues();

    expect(issues).toContain(
      'crete/facts.yaml: name: Too small: expected string to have >=1 characters',
    );
    expect(issues).toContain('crete/guide.md: missing YAML front matter');
    expect(issues.some((issue) => issue.startsWith('malta/facts.yaml: invalid YAML'))).toBe(true);
  });

  it('checks ids, parents, file names and revisions', async () => {
    await write('sicily/facts.yaml', stringify(facts({ id: 'sicilia' })));
    await write('sicily/guide.md', frontMatter({ revision_id: 1, parent: 'italy' }) + GUIDE_BODY);
    await write('crete/facts.yaml', stringify(facts({ id: 'crete' })));
    await write('crete/guide.md', frontMatter({ id: 'crete' }) + GUIDE_BODY);
    await write('crete/places/Bad Name.md', 'x');
    await write('crete/places/chania.md', frontMatter({ id: 'chania', parent: 'sicily' }));

    expect(await loadIssues()).toEqual([
      'crete/places/Bad Name.md: place files must be named <place-id>.md',
      'crete/places/chania.md: front matter must have id "chania" and parent "crete"',
      'sicily/facts.yaml: id "sicilia" must be "sicily"',
      'sicily/guide.md: front matter must have id "sicily" and no parent',
      'sicily/facts.yaml: source.revision_id 5320270 differs from the guide revision 1 (regenerate the facts)',
    ]);
  });

  it('reports missing files, invalid front matter and an empty corpus', async () => {
    await write('sicily/facts.yaml', stringify(facts()));
    await write('crete/facts.yaml', stringify(facts({ id: 'crete' })));
    await write('crete/guide.md', '---\nid: [\n---\nbody');

    const issues = await loadIssues();
    expect(issues).toContain('sicily/guide.md: missing');
    expect(
      issues.some((issue) => issue.startsWith('crete/guide.md: invalid front matter YAML')),
    ).toBe(true);

    const empty = await mkdtemp(path.join(tmpdir(), 'wanderly-empty-'));
    await expect(new FsCorpusSource(empty).load()).rejects.toThrow(
      'no destination directory found',
    );
    await rm(empty, { recursive: true, force: true });
  });

  it('points at the repository corpus by default', () => {
    expect(DEFAULT_CORPUS_DIR.replaceAll('\\', '/')).toMatch(/\/data\/corpus$/);
  });
});
