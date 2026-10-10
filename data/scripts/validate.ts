/**
 * Validates the corpus: every destination of data/destinations.yaml must have a guide.md with
 * valid front matter and a facts.yaml valid against the Zod schema, consistent with each other.
 * Prints per-destination statistics. Exits with code 1 when anything is invalid.
 *
 * Usage: npx tsx --conditions=development data/scripts/validate.ts
 */
import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { z } from 'zod';
import { loadDestinations } from './destinations.js';
import { FactsSchema, GuideFrontMatterSchema } from '@wanderly/contracts';
import { parseFrontMatter } from './front-matter.js';
import { CORPUS_DIR, factsPath, guidePath } from './paths.js';
import { countContentWords } from './wikitext.js';
import { readTextIfExists, readYamlFile } from './yaml-io.js';

/** Below this many words in See + Do, a destination is flagged as thin for a demo. */
const THIN_SEE_DO_WORDS = 150;

interface Stats {
  readonly id: string;
  readonly sections: number;
  readonly words: number;
  readonly seeDoWords: number;
  readonly listings: number;
  readonly pois: number;
  readonly pricedListings: number;
  readonly climateMonths: number;
}

/** Splits a guide body into top-level (`##`) sections: title → text including subsections. */
function topLevelSections(body: string): Map<string, string> {
  const sections = new Map<string, string>();
  let title: string | null = null;
  let lines: string[] = [];
  const flush = (): void => {
    if (title !== null) sections.set(title, lines.join('\n'));
  };
  for (const line of body.split('\n')) {
    const heading = /^## (.+)$/.exec(line);
    if (heading?.[1] !== undefined) {
      flush();
      title = heading[1].trim();
      lines = [];
    } else {
      lines.push(line);
    }
  }
  flush();
  return sections;
}

async function validateDestination(
  id: string,
  expected: { name: string; country: string },
): Promise<{ stats: Stats | null; errors: string[] }> {
  const errors: string[] = [];
  const guideText = await readTextIfExists(guidePath(id));
  if (guideText === null) return { stats: null, errors: ['guide.md is missing'] };
  let body = '';
  let guideRevision: number | null = null;
  try {
    const parsed = parseFrontMatter(guideText);
    body = parsed.body;
    const frontMatter = GuideFrontMatterSchema.safeParse(parsed.data);
    if (frontMatter.success) {
      guideRevision = frontMatter.data.revision_id;
      if (frontMatter.data.id !== id) errors.push(`guide.md id is "${frontMatter.data.id}"`);
    } else {
      errors.push(`guide.md front matter: ${z.prettifyError(frontMatter.error)}`);
    }
  } catch (error) {
    errors.push(`guide.md: ${error instanceof Error ? error.message : String(error)}`);
  }
  if (countContentWords(body) === 0) errors.push('guide.md body is empty');

  let facts: z.infer<typeof FactsSchema> | null = null;
  try {
    const parsed = FactsSchema.safeParse(await readYamlFile(factsPath(id)));
    if (parsed.success) facts = parsed.data;
    else errors.push(`facts.yaml: ${z.prettifyError(parsed.error)}`);
  } catch (error) {
    errors.push(`facts.yaml: ${error instanceof Error ? error.message : String(error)}`);
  }
  if (facts !== null) {
    if (facts.id !== id) errors.push(`facts.yaml id is "${facts.id}"`);
    if (facts.name !== expected.name || facts.country !== expected.country) {
      errors.push('facts.yaml name/country differ from destinations.yaml (rebuild facts)');
    }
    if (guideRevision !== null && facts.source.revision_id !== guideRevision) {
      errors.push(
        `facts.yaml is built from r${facts.source.revision_id} but guide.md is r${guideRevision}`,
      );
    }
  }

  const sections = topLevelSections(body);
  const seeDo = [sections.get('See') ?? '', sections.get('Do') ?? ''].join('\n');
  return {
    errors,
    stats: {
      id,
      sections: (body.match(/^#{2,6} /gm) ?? []).length,
      words: countContentWords(body),
      seeDoWords: countContentWords(seeDo),
      listings: facts?.extraction.listings ?? 0,
      pois: facts?.pois.length ?? 0,
      pricedListings:
        (facts?.extraction.priced_listings.sleep ?? 0) +
        (facts?.extraction.priced_listings.eat ?? 0),
      climateMonths: facts?.climate.months.length ?? 0,
    },
  };
}

function printTable(rows: readonly Stats[]): void {
  const header = [
    'destination',
    'sections',
    'words',
    'see+do words',
    'listings',
    'POIs',
    'priced listings',
    'climate months',
  ];
  const body = rows.map((row) => [
    row.id,
    String(row.sections),
    String(row.words),
    String(row.seeDoWords),
    String(row.listings),
    String(row.pois),
    String(row.pricedListings),
    String(row.climateMonths),
  ]);
  const total = [
    'TOTAL',
    ...[1, 2, 3, 4, 5, 6].map((column) =>
      String(body.reduce((sum, row) => sum + Number(row[column] ?? 0), 0)),
    ),
    '',
  ];
  const table = [header, ...body, total];
  const widths = header.map((_, column) =>
    Math.max(...table.map((row) => (row[column] ?? '').length)),
  );
  const line = (row: readonly string[]): string =>
    `| ${row.map((cellText, column) => (column === 0 ? cellText.padEnd(widths[column] ?? 0) : cellText.padStart(widths[column] ?? 0))).join(' | ')} |`;
  console.log(line(header));
  console.log(
    `| ${widths.map((width, column) => (column === 0 ? '-'.repeat(width) : `${'-'.repeat(width - 1)}:`)).join(' | ')} |`,
  );
  for (const row of [...body, total]) console.log(line(row));
}

async function main(): Promise<void> {
  const destinations = await loadDestinations();
  const errors: string[] = [];
  const rows: Stats[] = [];
  for (const destination of destinations) {
    const result = await validateDestination(destination.id, destination);
    errors.push(...result.errors.map((error) => `${destination.id}: ${error}`));
    if (result.stats !== null) rows.push(result.stats);
  }

  const known = new Set(destinations.map((d) => d.id));
  const entries = await readdir(CORPUS_DIR, { withFileTypes: true });
  for (const entry of entries) {
    if (entry.isDirectory() && !known.has(entry.name)) {
      errors.push(`${entry.name}: corpus directory not listed in destinations.yaml`);
    }
  }
  const attribution = await readTextIfExists(path.join(CORPUS_DIR, 'ATTRIBUTION.md'));
  if (attribution === null) {
    errors.push('ATTRIBUTION.md is missing');
  } else {
    for (const destination of destinations) {
      const guide = await readFile(guidePath(destination.id), 'utf8').catch(() => null);
      const revision =
        guide === null ? null : GuideFrontMatterSchema.safeParse(parseFrontMatter(guide).data);
      if (revision?.success && !attribution.includes(revision.data.revision_url)) {
        errors.push(
          `${destination.id}: ATTRIBUTION.md does not cite revision ${revision.data.revision_id}`,
        );
      }
    }
  }

  printTable(rows);
  const thin = rows.filter((row) => row.seeDoWords < THIN_SEE_DO_WORDS || row.pois < 5);
  if (thin.length > 0) {
    console.log(
      `\nThin for a demo (see+do < ${THIN_SEE_DO_WORDS} words or < 5 POIs): ${thin.map((row) => row.id).join(', ')}`,
    );
  }
  if (errors.length > 0) {
    console.error(`\n${errors.length} problem(s):`);
    for (const error of errors) console.error(`- ${error}`);
    process.exitCode = 1;
  } else {
    console.log(`\nOK: ${rows.length} destinations valid.`);
  }
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
