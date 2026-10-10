/**
 * Downloads the Wikivoyage articles listed in data/destinations.yaml (the region article and its
 * place articles) and writes data/corpus/<id>/guide.md and data/corpus/<id>/places/<place-id>.md
 * (Markdown + YAML front matter with provenance and licence).
 *
 * Usage: npx tsx --conditions=development data/scripts/fetch-wikivoyage.ts [--only <id>] [--latest]
 *
 * Reproducibility: by default the revision recorded in an existing Markdown file is re-used (from
 * the raw cache, or fetched by revision id), so regenerating gives the same text. `--latest` moves
 * to the current revision of every selected article. Requests are sequential and paced. Place
 * files that are no longer listed in destinations.yaml are deleted.
 *
 * Downloaded wikitext is untrusted data: it is only parsed and converted, never interpreted.
 */
import { readdir, rm } from 'node:fs/promises';
import path from 'node:path';
import { type GuideFrontMatter, GuideFrontMatterSchema } from '@wanderly/contracts';
import { parseCliArgs } from './cli-args.js';
import {
  type DocumentSpec,
  destinationDocuments,
  loadDestinations,
  selectDestinations,
} from './destinations.js';
import { parseFrontMatter, withFrontMatter } from './front-matter.js';
import { RequestPacer } from './http.js';
import {
  type SiteLicense,
  fetchArticleRevision,
  fetchSiteLicense,
  historyUrl,
  revisionUrl,
} from './mediawiki.js';
import { documentPath, placesDir } from './paths.js';
import { type RawArticle, readRawArticle, writeRawArticle } from './raw-cache.js';
import {
  collectListings,
  convertArticle,
  countContentWords,
  renderGuideMarkdown,
} from './wikitext.js';
import { readTextIfExists, writeTextFile } from './yaml-io.js';

/** Wikimedia asks API clients to keep requests sequential; one per second is comfortably polite. */
const pacer = new RequestPacer(1000);

/** Revision recorded in the current Markdown file of the document, if it is about the same page. */
async function pinnedRevision(spec: DocumentSpec): Promise<number | null> {
  const text = await readTextIfExists(documentPath(spec.destinationId, spec.placeId));
  if (text === null) return null;
  const parsed = GuideFrontMatterSchema.safeParse(parseFrontMatter(text).data);
  if (!parsed.success || parsed.data.title !== spec.title) return null;
  return parsed.data.revision_id;
}

async function loadArticle(
  spec: DocumentSpec,
  latest: boolean,
  license: () => Promise<SiteLicense>,
): Promise<{ article: RawArticle; origin: string }> {
  const pinned = latest ? null : await pinnedRevision(spec);
  const cached = await readRawArticle(spec.destinationId, spec.placeId);
  const cacheMatches =
    cached !== null &&
    cached.title === spec.title &&
    (pinned === null ? !latest : cached.revision_id === pinned);
  if (cached !== null && cacheMatches) return { article: cached, origin: 'cache' };

  const revision = await fetchArticleRevision({ title: spec.title, revisionId: pinned }, pacer);
  const article: RawArticle = {
    title: revision.title,
    page_id: revision.pageId,
    revision_id: revision.revisionId,
    revision_timestamp: revision.revisionTimestamp,
    canonical_url: revision.canonicalUrl,
    coordinates: revision.coordinates,
    retrieved_at: new Date().toISOString(),
    license: await license(),
    wikitext: revision.wikitext,
  };
  await writeRawArticle(spec.destinationId, spec.placeId, article);
  return { article, origin: pinned === null ? 'fetched latest' : `fetched pinned r${pinned}` };
}

function buildFrontMatter(
  spec: DocumentSpec,
  article: RawArticle,
  isPartOf: readonly string[],
): GuideFrontMatter {
  const attribution =
    `"${article.title}" by Wikivoyage contributors (${historyUrl(article.title)}), ` +
    `licensed under ${article.license.name} (${article.license.url}). ` +
    'Converted to Markdown for Wanderly: images, maps, navigation and status templates, ' +
    'references and empty sections removed; listings reformatted as bullet items.';
  return GuideFrontMatterSchema.parse({
    id: spec.placeId ?? spec.destinationId,
    title: article.title,
    source_url: article.canonical_url,
    revision_id: article.revision_id,
    revision_timestamp: article.revision_timestamp,
    revision_url: revisionUrl(article.title, article.revision_id),
    retrieved_at: article.retrieved_at,
    license: article.license.name,
    license_url: article.license.url,
    attribution,
    is_part_of: [...isPartOf],
    ...(spec.placeId === null ? {} : { parent: spec.destinationId }),
  });
}

/** Deletes place files that destinations.yaml no longer lists (keeps the corpus regenerable). */
async function removeStalePlaces(
  destinationId: string,
  placeIds: readonly string[],
): Promise<void> {
  const dir = placesDir(destinationId);
  const files = await readdir(dir).catch(() => [] as string[]);
  const expected = new Set(placeIds.map((id) => `${id}.md`));
  for (const file of files) {
    if (!expected.has(file)) {
      await rm(path.join(dir, file));
      console.log(`  removed stale ${destinationId}/places/${file}`);
    }
  }
  if (placeIds.length === 0) await rm(dir, { recursive: true, force: true });
}

async function main(): Promise<void> {
  const options = parseCliArgs(process.argv.slice(2), ['--latest']);
  const destinations = selectDestinations(await loadDestinations(), options.only);
  let license: SiteLicense | null = null;
  const getLicense = async (): Promise<SiteLicense> => {
    license ??= await fetchSiteLicense(pacer);
    return license;
  };

  for (const destination of destinations) {
    for (const spec of destinationDocuments(destination)) {
      const { article, origin } = await loadArticle(
        spec,
        options.flags.has('--latest'),
        getLicense,
      );
      const doc = convertArticle(article.title, article.wikitext);
      const body = renderGuideMarkdown(doc);
      const frontMatter = buildFrontMatter(spec, article, doc.isPartOf);
      await writeTextFile(
        documentPath(spec.destinationId, spec.placeId),
        withFrontMatter(frontMatter, body),
      );
      const label = spec.placeId === null ? destination.id : `  ${spec.placeId}`;
      console.log(
        `${label.padEnd(24)} r${article.revision_id} (${origin}): ` +
          `${doc.sections.length} sections, ${countContentWords(body)} words, ` +
          `${collectListings(doc).length} listings`,
      );
      for (const warning of doc.warnings) console.warn(`  warning: ${warning}`);
    }
    await removeStalePlaces(
      destination.id,
      destination.places.map((place) => place.id),
    );
  }
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
