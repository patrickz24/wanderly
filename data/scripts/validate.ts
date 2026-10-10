/**
 * Validates the corpus: for every destination of data/destinations.yaml, its region guide and
 * place articles must exist with valid front matter, facts.yaml must be valid against the Zod
 * schema and built from exactly those documents and revisions, and ATTRIBUTION.md must cite every
 * revision. Prints per-destination statistics. Exits with code 1 when anything is invalid.
 *
 * Usage: npx tsx --conditions=development data/scripts/validate.ts
 */
import { readdir } from 'node:fs/promises';
import path from 'node:path';
import {
  type CostLevel,
  type Facts,
  FactsSchema,
  type GuideFrontMatter,
  GuideFrontMatterSchema,
} from '@wanderly/contracts';
import { z } from 'zod';
import {
  type Destination,
  type DocumentSpec,
  destinationDocuments,
  loadDestinations,
} from './destinations.js';
import { parseFrontMatter } from './front-matter.js';
import { CORPUS_DIR, documentFile, documentPath, factsPath, placesDir } from './paths.js';
import { countContentWords } from './wikitext.js';
import { readTextIfExists, readYamlFile } from './yaml-io.js';

/** Below this many words in See + Do (all documents), a destination is flagged as thin. */
const THIN_SEE_DO_WORDS = 150;
const THIN_POIS = 5;

interface Stats {
  readonly id: string;
  readonly documents: number;
  readonly sections: number;
  readonly words: number;
  readonly seeDoWords: number;
  readonly listings: number;
  readonly pois: number;
  readonly pricedListings: number;
  /** Non-null cost figures (lodging_night, meal) per level: 0, 1 or 2. */
  readonly costs: { overall: number; budget: number; mid: number; comfort: number };
  readonly climateMonths: number;
  /** POIs with a curated crowd level / with best months. */
  readonly crowdLevels: number;
  readonly bestMonths: number;
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

interface CheckedDocument {
  readonly spec: DocumentSpec;
  readonly frontMatter: GuideFrontMatter | null;
  readonly body: string;
}

async function checkDocument(spec: DocumentSpec, errors: string[]): Promise<CheckedDocument> {
  const file = documentFile(spec.placeId);
  const text = await readTextIfExists(documentPath(spec.destinationId, spec.placeId));
  if (text === null) {
    errors.push(`${file} is missing`);
    return { spec, frontMatter: null, body: '' };
  }
  try {
    const { data, body } = parseFrontMatter(text);
    const parsed = GuideFrontMatterSchema.safeParse(data);
    if (!parsed.success) {
      errors.push(`${file} front matter: ${z.prettifyError(parsed.error)}`);
      return { spec, frontMatter: null, body };
    }
    const frontMatter = parsed.data;
    const expectedId = spec.placeId ?? spec.destinationId;
    const expectedParent = spec.placeId === null ? undefined : spec.destinationId;
    if (frontMatter.id !== expectedId) errors.push(`${file} id is "${frontMatter.id}"`);
    if (frontMatter.parent !== expectedParent) errors.push(`${file} has a wrong parent`);
    if (frontMatter.title !== spec.title) errors.push(`${file} is not "${spec.title}"`);
    if (countContentWords(body) === 0) errors.push(`${file} body is empty`);
    return { spec, frontMatter, body };
  } catch (error) {
    errors.push(`${file}: ${error instanceof Error ? error.message : String(error)}`);
    return { spec, frontMatter: null, body: '' };
  }
}

async function readFacts(id: string, errors: string[]): Promise<Facts | null> {
  try {
    const parsed = FactsSchema.safeParse(await readYamlFile(factsPath(id)));
    if (parsed.success) return parsed.data;
    errors.push(`facts.yaml: ${z.prettifyError(parsed.error)}`);
  } catch (error) {
    errors.push(`facts.yaml: ${error instanceof Error ? error.message : String(error)}`);
  }
  return null;
}

function checkFactsAgainstDocuments(
  destination: Destination,
  facts: Facts,
  documents: readonly CheckedDocument[],
  errors: string[],
): void {
  if (facts.id !== destination.id) errors.push(`facts.yaml id is "${facts.id}"`);
  if (facts.name !== destination.name || facts.country !== destination.country) {
    errors.push('facts.yaml name/country differ from destinations.yaml (rebuild facts)');
  }
  const recorded = facts.documents ?? [];
  const expected = documents.map(({ spec, frontMatter }) => ({
    file: documentFile(spec.placeId),
    revision: frontMatter?.revision_id ?? null,
  }));
  const same =
    recorded.length === expected.length &&
    recorded.every(
      (document, index) =>
        document.file === expected[index]?.file &&
        document.revision_id === expected[index]?.revision,
    );
  if (!same) errors.push('facts.yaml documents differ from the Markdown files (rebuild facts)');
}

/**
 * Curated values must carry evidence, and every evidence sentence must appear verbatim in the
 * Markdown document named by the POI's source_ref.
 */
function checkEvidence(
  facts: Facts,
  documents: readonly CheckedDocument[],
  errors: string[],
): void {
  const bodies = new Map(
    documents.flatMap(({ frontMatter, body }) =>
      frontMatter === null ? [] : [[frontMatter.title, body] as const],
    ),
  );
  for (const poi of facts.pois) {
    const crowd = poi.crowd_evidence ?? [];
    const months = poi.months_evidence ?? [];
    if (
      (poi.crowd_level !== null && crowd.length === 0) ||
      (poi.best_months.length > 0 && months.length === 0)
    ) {
      errors.push(`${poi.id}: curated value without evidence`);
    }
    const body = [...bodies.entries()].find(([title]) =>
      poi.source_ref.startsWith(`${title} > `),
    )?.[1];
    for (const sentence of [...crowd, ...months]) {
      if (body === undefined || !body.includes(sentence)) {
        errors.push(
          `${poi.id}: evidence not found verbatim in its document: "${sentence.slice(0, 60)}"`,
        );
      }
    }
  }
}

async function orphanPlaceFiles(destination: Destination): Promise<string[]> {
  const files = await readdir(placesDir(destination.id)).catch(() => [] as string[]);
  const expected = new Set(destination.places.map((place) => `${place.id}.md`));
  return files.filter((file) => !expected.has(file)).map((file) => `places/${file}`);
}

const nonNullFigures = (level: CostLevel): number =>
  Number(level.lodging_night !== null) + Number(level.meal !== null);

async function validateDestination(
  destination: Destination,
  attribution: string | null,
): Promise<{ stats: Stats; errors: string[] }> {
  const errors: string[] = [];
  const documents: CheckedDocument[] = [];
  for (const spec of destinationDocuments(destination)) {
    documents.push(await checkDocument(spec, errors));
  }
  for (const orphan of await orphanPlaceFiles(destination)) {
    errors.push(`${orphan} is not listed in destinations.yaml`);
  }
  for (const { spec, frontMatter } of documents) {
    if (attribution !== null && frontMatter !== null) {
      if (!attribution.includes(frontMatter.revision_url)) {
        errors.push(
          `ATTRIBUTION.md does not cite ${documentFile(spec.placeId)} r${frontMatter.revision_id}`,
        );
      }
    }
  }
  const facts = await readFacts(destination.id, errors);
  if (facts !== null) {
    checkFactsAgainstDocuments(destination, facts, documents, errors);
    checkEvidence(facts, documents, errors);
  }

  const seeDo = documents.flatMap(({ body }) => {
    const sections = topLevelSections(body);
    return [sections.get('See') ?? '', sections.get('Do') ?? ''];
  });
  const levels = facts?.costs.levels;
  return {
    errors,
    stats: {
      id: destination.id,
      documents: documents.length,
      sections: documents.reduce(
        (sum, { body }) => sum + (body.match(/^#{2,6} /gm) ?? []).length,
        0,
      ),
      words: documents.reduce((sum, { body }) => sum + countContentWords(body), 0),
      seeDoWords: countContentWords(seeDo.join('\n')),
      listings: facts?.extraction.listings ?? 0,
      pois: facts?.pois.length ?? 0,
      pricedListings:
        (facts?.extraction.priced_listings.sleep ?? 0) +
        (facts?.extraction.priced_listings.eat ?? 0),
      costs: {
        overall: facts === null ? 0 : nonNullFigures(facts.costs.overall),
        budget: levels === undefined ? 0 : nonNullFigures(levels.budget),
        mid: levels === undefined ? 0 : nonNullFigures(levels.mid),
        comfort: levels === undefined ? 0 : nonNullFigures(levels.comfort),
      },
      climateMonths: facts?.climate.months.length ?? 0,
      crowdLevels: facts?.pois.filter((poi) => poi.crowd_level !== null).length ?? 0,
      bestMonths: facts?.pois.filter((poi) => poi.best_months.length > 0).length ?? 0,
    },
  };
}

function printTable(rows: readonly Stats[]): void {
  const header = [
    'destination',
    'docs',
    'sections',
    'words',
    'see+do words',
    'listings',
    'POIs',
    'priced listings',
    'costs overall',
    'budget',
    'mid',
    'comfort',
    'climate months',
    'crowd',
    'months',
  ];
  const body = rows.map((row) => [
    row.id,
    ...[
      row.documents,
      row.sections,
      row.words,
      row.seeDoWords,
      row.listings,
      row.pois,
      row.pricedListings,
      row.costs.overall,
      row.costs.budget,
      row.costs.mid,
      row.costs.comfort,
      row.climateMonths,
      row.crowdLevels,
      row.bestMonths,
    ].map(String),
  ]);
  const total = [
    'TOTAL',
    ...[1, 2, 3, 4, 5, 6, 7].map((column) =>
      String(body.reduce((sum, row) => sum + Number(row[column] ?? 0), 0)),
    ),
    ...['', '', '', '', ''],
    ...[13, 14].map((column) =>
      String(body.reduce((sum, row) => sum + Number(row[column] ?? 0), 0)),
    ),
  ];
  const table = [header, ...body, total];
  const widths = header.map((_, column) =>
    Math.max(...table.map((row) => (row[column] ?? '').length)),
  );
  const line = (row: readonly string[]): string =>
    `| ${row
      .map((text, column) =>
        column === 0 ? text.padEnd(widths[column] ?? 0) : text.padStart(widths[column] ?? 0),
      )
      .join(' | ')} |`;
  console.log(line(header));
  console.log(
    `| ${widths.map((width, column) => (column === 0 ? '-'.repeat(width) : `${'-'.repeat(width - 1)}:`)).join(' | ')} |`,
  );
  for (const row of [...body, total]) console.log(line(row));
  console.log(
    '\nCost columns: non-null figures (lodging_night, meal) out of 2, overall and per level.',
  );
}

async function main(): Promise<void> {
  const destinations = await loadDestinations();
  const errors: string[] = [];
  const rows: Stats[] = [];
  const attribution = await readTextIfExists(path.join(CORPUS_DIR, 'ATTRIBUTION.md'));
  if (attribution === null) errors.push('ATTRIBUTION.md is missing');
  for (const destination of destinations) {
    const result = await validateDestination(destination, attribution);
    errors.push(...result.errors.map((error) => `${destination.id}: ${error}`));
    rows.push(result.stats);
  }
  const known = new Set(destinations.map((d) => d.id));
  for (const entry of await readdir(CORPUS_DIR, { withFileTypes: true })) {
    if (entry.isDirectory() && !known.has(entry.name)) {
      errors.push(`${entry.name}: corpus directory not listed in destinations.yaml`);
    }
  }

  printTable(rows);
  const thin = rows.filter((row) => row.seeDoWords < THIN_SEE_DO_WORDS || row.pois < THIN_POIS);
  if (thin.length > 0) {
    console.log(
      `\nThin for a demo (see+do < ${THIN_SEE_DO_WORDS} words or < ${THIN_POIS} POIs): ` +
        thin.map((row) => row.id).join(', '),
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
