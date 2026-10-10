/**
 * Downloads the Wikivoyage articles listed in data/destinations.yaml and writes
 * data/corpus/<id>/guide.md (Markdown + YAML front matter with provenance and licence).
 *
 * Usage: npx tsx --conditions=development data/scripts/fetch-wikivoyage.ts [--only <id>] [--latest]
 *
 * Reproducibility: by default the revision recorded in an existing guide.md is re-used (from the
 * raw cache, or fetched by revision id), so regenerating gives the same text. `--latest` moves
 * to the current revision of every selected article. Requests are sequential and paced.
 *
 * Downloaded wikitext is untrusted data: it is only parsed and converted, never interpreted.
 */
import { parseCliArgs } from './cli-args.js';
import { type Destination, loadDestinations, selectDestinations } from './destinations.js';
import { withFrontMatter, parseFrontMatter } from './front-matter.js';
import { type GuideFrontMatter, GuideFrontMatterSchema } from '@wanderly/contracts';
import { RequestPacer } from './http.js';
import {
  type SiteLicense,
  fetchArticleRevision,
  fetchSiteLicense,
  historyUrl,
  revisionUrl,
} from './mediawiki.js';
import { guidePath } from './paths.js';
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

/** Revision recorded in the current guide.md, if it is about the same page. */
async function pinnedRevision(destination: Destination): Promise<number | null> {
  const text = await readTextIfExists(guidePath(destination.id));
  if (text === null) return null;
  const parsed = GuideFrontMatterSchema.safeParse(parseFrontMatter(text).data);
  if (!parsed.success || parsed.data.title !== destination.wikivoyage_title) return null;
  return parsed.data.revision_id;
}

async function loadArticle(
  destination: Destination,
  latest: boolean,
  license: () => Promise<SiteLicense>,
): Promise<{ article: RawArticle; origin: string }> {
  const pinned = latest ? null : await pinnedRevision(destination);
  const cached = await readRawArticle(destination.id);
  const cacheMatches =
    cached !== null &&
    cached.title === destination.wikivoyage_title &&
    (pinned === null ? !latest : cached.revision_id === pinned);
  if (cached !== null && cacheMatches) return { article: cached, origin: 'cache' };

  const revision = await fetchArticleRevision(
    { title: destination.wikivoyage_title, revisionId: pinned },
    pacer,
  );
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
  await writeRawArticle(destination.id, article);
  return { article, origin: pinned === null ? 'fetched latest' : `fetched pinned r${pinned}` };
}

function buildFrontMatter(
  destination: Destination,
  article: RawArticle,
  isPartOf: readonly string[],
): GuideFrontMatter {
  const attribution =
    `"${article.title}" by Wikivoyage contributors (${historyUrl(article.title)}), ` +
    `licensed under ${article.license.name} (${article.license.url}). ` +
    'Converted to Markdown for Wanderly: images, maps, navigation and status templates, ' +
    'references and empty sections removed; listings reformatted as bullet items.';
  return GuideFrontMatterSchema.parse({
    id: destination.id,
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
  });
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
    const { article, origin } = await loadArticle(
      destination,
      options.flags.has('--latest'),
      getLicense,
    );
    const doc = convertArticle(article.title, article.wikitext);
    const body = renderGuideMarkdown(doc);
    const frontMatter = buildFrontMatter(destination, article, doc.isPartOf);
    await writeTextFile(guidePath(destination.id), withFrontMatter(frontMatter, body));
    console.log(
      `${destination.id.padEnd(20)} r${article.revision_id} (${origin}): ` +
        `${doc.sections.length} sections, ${countContentWords(body)} words, ` +
        `${collectListings(doc).length} listings`,
    );
    for (const warning of doc.warnings) console.warn(`  warning: ${warning}`);
  }
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
