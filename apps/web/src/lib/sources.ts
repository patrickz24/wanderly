import type { SourceKind, SourceRef, SourceSummary } from '@wanderly/contracts';

/** Identity of a source within one answer: kind and id together (ids are unique per kind). */
export function sourceKey(ref: Pick<SourceRef, 'kind' | 'id'>): string {
  return `${ref.kind}:${ref.id}`;
}

/** 1-based footnote number of each source of an answer, in the order the API listed them. */
export function numberSources(sources: readonly SourceSummary[]): ReadonlyMap<string, number> {
  const numbers = new Map<string, number>();
  for (const source of sources) {
    const key = sourceKey(source);
    if (!numbers.has(key)) {
      numbers.set(key, numbers.size + 1);
    }
  }
  return numbers;
}

export const SOURCE_KIND_LABELS: Readonly<Record<SourceKind, string>> = {
  chunk: 'Guide excerpt',
  poi: 'Place',
  weather: 'Weather',
  budget: 'Budget estimate',
};

export const WIKIVOYAGE_LICENSE = {
  name: 'CC BY-SA 4.0',
  url: 'https://creativecommons.org/licenses/by-sa/4.0/deed.en',
} as const;

export const OPEN_METEO = {
  text: 'Weather data by Open-Meteo.com',
  url: 'https://open-meteo.com/',
} as const;

/**
 * Only http(s) links are rendered. The contract validates `url` as a URL, but a URL can still
 * use a scheme we never want to put in an `href` (`javascript:`, `data:`).
 */
export function safeExternalUrl(url: string | null): string | null {
  if (url === null) {
    return null;
  }
  try {
    const parsed = new URL(url);
    return parsed.protocol === 'https:' || parsed.protocol === 'http:' ? parsed.href : null;
  } catch {
    return null;
  }
}

/** Whether a source's text comes from Wikivoyage, whose licence requires attribution. */
export function isWikivoyageUrl(url: string | null): boolean {
  const safe = safeExternalUrl(url);
  if (safe === null) {
    return false;
  }
  const host = new URL(safe).hostname;
  return host === 'wikivoyage.org' || host.endsWith('.wikivoyage.org');
}
