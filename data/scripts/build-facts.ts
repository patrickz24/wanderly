/**
 * Builds data/corpus/<id>/facts.yaml from the destination's documents (the region guide and its
 * place articles, converted again from the raw cache at the revisions recorded in their Markdown
 * front matter) and the climate normals (data/climate/<id>.yaml). Also regenerates
 * data/corpus/ATTRIBUTION.md for every destination.
 *
 * Usage: npx tsx --conditions=development data/scripts/build-facts.ts [--only <id>]
 * Prerequisites: fetch-wikivoyage.ts and fetch-climate.ts have run for the destination.
 */
import path from 'node:path';
import {
  type CorpusDocument,
  FACTS_SCHEMA_VERSION,
  type Facts,
  FactsSchema,
  type GuideFrontMatter,
  GuideFrontMatterSchema,
} from '@wanderly/contracts';
import { z } from 'zod';
import { type AttributionEntry, renderAttribution } from './attribution.js';
import { parseCliArgs } from './cli-args.js';
import { type ClimateFile, ClimateFileSchema } from './climate.js';
import { deriveCosts } from './costs.js';
import {
  type Destination,
  type DocumentSpec,
  destinationDocuments,
  loadDestinations,
  selectDestinations,
} from './destinations.js';
import { parseFrontMatter } from './front-matter.js';
import { CORPUS_DIR, climatePath, documentFile, documentPath, factsPath } from './paths.js';
import { type PoiCandidate, buildPois, collectPoiCandidates } from './pois.js';
import { readRawArticle } from './raw-cache.js';
import { type GuideDocument, collectListings, convertArticle } from './wikitext.js';
import { readTextIfExists, readYamlFile, writeTextFile, writeYamlFile } from './yaml-io.js';

interface LoadedDocument {
  readonly spec: DocumentSpec;
  readonly frontMatter: GuideFrontMatter;
  readonly doc: GuideDocument;
}

const relative = (spec: DocumentSpec): string =>
  `${spec.destinationId}/${documentFile(spec.placeId)}`;

async function readFrontMatter(spec: DocumentSpec): Promise<GuideFrontMatter> {
  const text = await readTextIfExists(documentPath(spec.destinationId, spec.placeId));
  if (text === null) {
    throw new Error(`${relative(spec)} is missing: run fetch-wikivoyage.ts first`);
  }
  const frontMatter = GuideFrontMatterSchema.parse(parseFrontMatter(text).data);
  const expectedParent = spec.placeId === null ? undefined : spec.destinationId;
  if (frontMatter.title !== spec.title || frontMatter.parent !== expectedParent) {
    throw new Error(`${relative(spec)} does not match destinations.yaml: run fetch-wikivoyage.ts`);
  }
  return frontMatter;
}

/** Converts the document again from the raw cache, at the revision recorded in its Markdown. */
async function loadDocument(spec: DocumentSpec): Promise<LoadedDocument> {
  const frontMatter = await readFrontMatter(spec);
  const article = await readRawArticle(spec.destinationId, spec.placeId);
  if (article === null || article.revision_id !== frontMatter.revision_id) {
    throw new Error(
      `${relative(spec)}: raw cache missing or not at revision ${frontMatter.revision_id}; run ` +
        `"npx tsx --conditions=development data/scripts/fetch-wikivoyage.ts --only ${spec.destinationId}"`,
    );
  }
  return { spec, frontMatter, doc: convertArticle(article.title, article.wikitext) };
}

async function readClimate(destinationId: string): Promise<ClimateFile> {
  const parsed = ClimateFileSchema.safeParse(await readYamlFile(climatePath(destinationId)));
  if (!parsed.success) {
    throw new Error(
      `${destinationId}: invalid or missing climate file, run fetch-climate.ts first\n` +
        z.prettifyError(parsed.error),
    );
  }
  return parsed.data;
}

function documentEntry({ spec, frontMatter }: LoadedDocument): CorpusDocument {
  return {
    file: documentFile(spec.placeId),
    role: spec.role,
    id: frontMatter.id,
    title: frontMatter.title,
    url: frontMatter.source_url,
    revision_id: frontMatter.revision_id,
    license: frontMatter.license,
  };
}

async function buildFacts(destination: Destination): Promise<Facts> {
  const documents: LoadedDocument[] = [];
  for (const spec of destinationDocuments(destination)) documents.push(await loadDocument(spec));
  const [region] = documents;
  if (region === undefined) throw new Error(`${destination.id}: no region document`);
  const climate = await readClimate(destination.id);

  const listingsByType: Record<string, number> = {};
  let listingCount = 0;
  const candidates: PoiCandidate[] = [];
  let genericPruned = 0;
  for (const { spec, doc } of documents) {
    for (const { listing } of collectListings(doc)) {
      listingsByType[listing.type] = (listingsByType[listing.type] ?? 0) + 1;
      listingCount++;
    }
    const collected = collectPoiCandidates(doc, { title: doc.title, placeId: spec.placeId });
    candidates.push(...collected.candidates);
    genericPruned += collected.genericPruned;
  }
  const { pois, sources, duplicatesDropped } = buildPois(destination.id, candidates);
  const { costs, pricedListings } = deriveCosts(documents.map(({ doc }) => doc));

  return FactsSchema.parse({
    schema_version: FACTS_SCHEMA_VERSION,
    id: destination.id,
    name: destination.name,
    country: destination.country,
    aliases: destination.aliases,
    is_part_of: region.frontMatter.is_part_of,
    source: {
      guide: 'guide.md',
      title: region.frontMatter.title,
      url: region.frontMatter.source_url,
      revision_id: region.frontMatter.revision_id,
      license: region.frontMatter.license,
    },
    documents: documents.map(documentEntry),
    climate: {
      provider: climate.provider,
      model: climate.model,
      period: climate.period,
      point: climate.point,
      grid_cell: climate.grid_cell,
      license: climate.license,
      attribution: climate.attribution,
      months: climate.months,
    },
    costs,
    pois,
    extraction: {
      listings: listingCount,
      listings_by_type: Object.fromEntries(
        Object.entries(listingsByType).sort(([a], [b]) => a.localeCompare(b)),
      ),
      priced_listings: pricedListings,
      poi_sources: sources,
      duplicate_pois_dropped: duplicatesDropped,
      generic_items_pruned: genericPruned,
    },
  } satisfies Facts);
}

/** ATTRIBUTION.md covers every document of every destination, whatever the `--only` filter. */
async function writeAttribution(destinations: readonly Destination[]): Promise<void> {
  const entries: AttributionEntry[] = [];
  for (const destination of destinations) {
    const documents = [];
    for (const spec of destinationDocuments(destination)) {
      documents.push({ spec, frontMatter: await readFrontMatter(spec) });
    }
    entries.push({ destination, documents, climate: await readClimate(destination.id) });
  }
  await writeTextFile(path.join(CORPUS_DIR, 'ATTRIBUTION.md'), renderAttribution(entries));
}

async function main(): Promise<void> {
  const options = parseCliArgs(process.argv.slice(2), []);
  const all = await loadDestinations();
  const destinations = selectDestinations(all, options.only);
  for (const destination of destinations) {
    const facts = await buildFacts(destination);
    await writeYamlFile(
      factsPath(destination.id),
      facts,
      'Generated by data/scripts/build-facts.ts. Do not edit by hand: change the sources or the\n' +
        'scripts and regenerate. Schema: packages/contracts/src/corpus.ts. Licence: see guide.md.',
    );
    const lodging = facts.costs.overall.lodging_night;
    console.log(
      `${destination.id.padEnd(20)} ${facts.documents?.length ?? 1} docs, ${facts.pois.length} POIs ` +
        `(listing ${facts.extraction.poi_sources.listing}, marker ${facts.extraction.poi_sources.marker}, ` +
        `named ${facts.extraction.poi_sources.named}, generic pruned ` +
        `${facts.extraction.generic_items_pruned ?? 0}), lodging median ` +
        `${lodging === null ? 'null' : `${lodging.median} ${lodging.currency} (n=${lodging.sample_size})`}`,
    );
  }
  await writeAttribution(all);
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
