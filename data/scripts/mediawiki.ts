/** Minimal MediaWiki Action API client for English Wikivoyage (read-only). */
import { z } from 'zod';
import { type RequestPacer, getJson, sleep } from './http.js';

export const WIKIVOYAGE_API = 'https://en.wikivoyage.org/w/api.php';

export interface SiteLicense {
  /** Short name derived from the licence URL, e.g. "CC BY-SA 4.0". */
  readonly name: string;
  /** Licence name as published by the wiki (siteinfo `rightsinfo.text`). */
  readonly text: string;
  readonly url: string;
}

export interface ArticleRevision {
  readonly title: string;
  readonly pageId: number;
  readonly revisionId: number;
  readonly revisionTimestamp: string;
  readonly canonicalUrl: string;
  /** Primary GeoData coordinates of the page (current revision), if any. */
  readonly coordinates: { readonly lat: number; readonly lon: number } | null;
  readonly wikitext: string;
}

const ApiErrorSchema = z.object({
  error: z.object({ code: z.string(), info: z.string() }).optional(),
});

const RightsSchema = z.object({
  query: z.object({ rightsinfo: z.object({ url: z.url(), text: z.string().min(1) }) }),
});

const RevisionQuerySchema = z.object({
  query: z.object({
    pages: z.array(
      z.object({
        pageid: z.number().optional(),
        title: z.string(),
        missing: z.boolean().optional(),
        invalid: z.boolean().optional(),
        canonicalurl: z.string().optional(),
        coordinates: z
          .array(z.object({ lat: z.number(), lon: z.number(), primary: z.boolean().optional() }))
          .optional(),
        revisions: z
          .array(
            z.object({
              revid: z.number(),
              timestamp: z.string(),
              slots: z.object({ main: z.object({ content: z.string() }) }),
            }),
          )
          .optional(),
      }),
    ),
    badrevids: z.record(z.string(), z.unknown()).optional(),
  }),
});

function apiUrl(params: Record<string, string>): URL {
  const url = new URL(WIKIVOYAGE_API);
  // maxlag: back off when the database replicas lag (Wikimedia API etiquette).
  const all = { format: 'json', formatversion: '2', maxlag: '5', ...params };
  for (const [key, value] of Object.entries(all)) url.searchParams.set(key, value);
  return url;
}

/** Calls the API, waiting and retrying when it answers `maxlag`. */
async function callApi(params: Record<string, string>, pacer: RequestPacer): Promise<unknown> {
  for (let attempt = 0; attempt < 5; attempt++) {
    const body = await getJson(apiUrl(params), { pacer });
    const error = ApiErrorSchema.parse(body).error;
    if (error === undefined) return body;
    if (error.code !== 'maxlag')
      throw new Error(`MediaWiki API error ${error.code}: ${error.info}`);
    await sleep(5000);
  }
  throw new Error('MediaWiki API kept answering maxlag');
}

export function shortLicenseName(url: string, text: string): string {
  const match = /licenses\/(by(?:-sa|-nc|-nd|-nc-sa|-nc-nd)?)\/(\d\.\d)/i.exec(url);
  return match?.[1] !== undefined && match[2] !== undefined
    ? `CC ${match[1].toUpperCase()} ${match[2]}`
    : text;
}

export async function fetchSiteLicense(pacer: RequestPacer): Promise<SiteLicense> {
  const body = await callApi({ action: 'query', meta: 'siteinfo', siprop: 'rightsinfo' }, pacer);
  const { url, text } = RightsSchema.parse(body).query.rightsinfo;
  return { name: shortLicenseName(url, text), text, url };
}

/**
 * Fetches one revision: the latest revision of `title`, or exactly `revisionId` when given
 * (pinned regeneration). Redirect pages are rejected: the destination list must use canonical
 * titles so that the corpus never silently follows a redirect.
 */
export async function fetchArticleRevision(
  target: { readonly title: string; readonly revisionId: number | null },
  pacer: RequestPacer,
): Promise<ArticleRevision> {
  const selector: Record<string, string> =
    target.revisionId === null ? { titles: target.title } : { revids: String(target.revisionId) };
  const body = await callApi(
    {
      action: 'query',
      prop: 'revisions|info|coordinates',
      rvprop: 'ids|timestamp|content',
      rvslots: 'main',
      inprop: 'url',
      colimit: 'max',
      ...selector,
    },
    pacer,
  );
  const { query } = RevisionQuerySchema.parse(body);
  if (query.badrevids !== undefined) {
    throw new Error(`Revision ${target.revisionId ?? '?'} of "${target.title}" does not exist`);
  }
  const page = query.pages[0];
  const revision = page?.revisions?.[0];
  if (
    page === undefined ||
    page.missing === true ||
    page.invalid === true ||
    revision === undefined
  ) {
    throw new Error(`Wikivoyage page "${target.title}" is missing`);
  }
  if (page.title !== target.title) {
    throw new Error(`Revision ${revision.revid} belongs to "${page.title}", not "${target.title}"`);
  }
  const wikitext = revision.slots.main.content;
  const redirect = /^\s*#redirect\s*\[\[([^\]]+)\]\]/i.exec(wikitext);
  if (redirect !== null) {
    throw new Error(`"${target.title}" redirects to "${redirect[1] ?? '?'}": use the target title`);
  }
  const primary = page.coordinates?.find((c) => c.primary === true) ?? page.coordinates?.[0];
  return {
    title: page.title,
    pageId: page.pageid ?? 0,
    revisionId: revision.revid,
    revisionTimestamp: revision.timestamp,
    canonicalUrl:
      page.canonicalurl ??
      `https://en.wikivoyage.org/wiki/${encodeURIComponent(page.title.replace(/ /g, '_'))}`,
    coordinates: primary === undefined ? null : { lat: primary.lat, lon: primary.lon },
    wikitext,
  };
}

const BatchQuerySchema = RevisionQuerySchema.extend({
  query: RevisionQuerySchema.shape.query.extend({
    normalized: z.array(z.object({ from: z.string(), to: z.string() })).optional(),
    redirects: z.array(z.object({ from: z.string(), to: z.string() })).optional(),
  }),
  continue: z.record(z.string(), z.union([z.string(), z.number()])).optional(),
});

export type BatchResult =
  | {
      readonly kind: 'page';
      readonly redirectedFrom: string | null;
      readonly revision: ArticleRevision;
    }
  | { readonly kind: 'missing' };

/**
 * Latest revisions of up to 50 titles in one request (following continuation when the content is
 * too large for one response). Redirects are followed and reported, so that callers can decide
 * whether the target is acceptable. Keys of the result are the requested titles.
 */
export async function fetchLatestRevisions(
  titles: readonly string[],
  pacer: RequestPacer,
): Promise<Map<string, BatchResult>> {
  if (titles.length > 50) throw new Error('fetchLatestRevisions accepts at most 50 titles');
  const base: Record<string, string> = {
    action: 'query',
    prop: 'revisions|info|coordinates',
    rvprop: 'ids|timestamp|content',
    rvslots: 'main',
    inprop: 'url',
    colimit: 'max',
    redirects: '1',
    titles: titles.join('|'),
  };
  const pages = new Map<string, ArticleRevision>();
  const aliases = new Map<string, string>();
  const redirected = new Set<string>();
  let extra: Record<string, string> = {};
  for (let round = 0; round < 20; round++) {
    const { query, continue: next } = BatchQuerySchema.parse(
      await callApi({ ...base, ...extra }, pacer),
    );
    for (const { from, to } of query.normalized ?? []) aliases.set(from, to);
    for (const { from, to } of query.redirects ?? []) {
      aliases.set(from, to);
      redirected.add(from);
    }
    for (const page of query.pages) {
      const revision = page.revisions?.[0];
      if (page.missing === true || page.invalid === true || revision === undefined) continue;
      const primary = page.coordinates?.find((c) => c.primary === true) ?? page.coordinates?.[0];
      pages.set(page.title, {
        title: page.title,
        pageId: page.pageid ?? 0,
        revisionId: revision.revid,
        revisionTimestamp: revision.timestamp,
        canonicalUrl:
          page.canonicalurl ??
          `https://en.wikivoyage.org/wiki/${encodeURIComponent(page.title.replace(/ /g, '_'))}`,
        coordinates: primary === undefined ? null : { lat: primary.lat, lon: primary.lon },
        wikitext: revision.slots.main.content,
      });
    }
    if (next === undefined) break;
    extra = Object.fromEntries(Object.entries(next).map(([key, value]) => [key, String(value)]));
  }
  const results = new Map<string, BatchResult>();
  for (const title of titles) {
    let current = title;
    let wasRedirected = false;
    for (let hop = 0; hop < 5 && aliases.has(current); hop++) {
      if (redirected.has(current)) wasRedirected = true;
      current = aliases.get(current) ?? current;
    }
    const revision = pages.get(current);
    results.set(
      title,
      revision === undefined
        ? { kind: 'missing' }
        : { kind: 'page', redirectedFrom: wasRedirected ? title : null, revision },
    );
  }
  return results;
}

export const revisionUrl = (title: string, revisionId: number): string =>
  `https://en.wikivoyage.org/w/index.php?title=${encodeURIComponent(title.replace(/ /g, '_'))}&oldid=${revisionId}`;

export const historyUrl = (title: string): string =>
  `https://en.wikivoyage.org/w/index.php?title=${encodeURIComponent(title.replace(/ /g, '_'))}&action=history`;
