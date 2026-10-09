/**
 * POI extraction from a converted guide (pure).
 *
 * Sources, in document order (documented in data/README.md):
 * - `listing`: see/do/event/listing templates in the See and Do sections (and subsections);
 * - `marker`: `{{marker}}` list items in "Other destinations" and in See/Do (Wikivoyage region
 *   articles name their attractions this way rather than with listings);
 * - `named`: list items of those sections that start with a bold or linked name
 *   (`* '''Valldemossa''' Charterhouse was…`). This heuristic also catches activity headers such
 *   as "Hiking:" or "Churches": they are kept (they describe things to do) and can be pruned by
 *   the later curation pass.
 * Cities/towns, regions, and Get in / Eat / Sleep listings are not POIs.
 */
import type { Poi } from './facts-schema.js';
import { mapKinds } from './poi-kinds.js';
import type { GuideDocument } from './wikitext.js';

export const POI_SECTIONS = ['see', 'do', 'other destinations'] as const;
const POI_LISTING_TYPES = new Set(['see', 'do', 'event', 'listing']);

export interface PoiCandidate {
  readonly name: string;
  readonly description: string | null;
  readonly sectionPath: readonly string[];
  readonly source: 'listing' | 'marker' | 'named';
}

const TRANSLITERATION: Readonly<Record<string, string>> = {
  þ: 'th',
  ð: 'd',
  æ: 'ae',
  ø: 'o',
  œ: 'oe',
  ß: 'ss',
  ł: 'l',
  đ: 'd',
  ı: 'i',
};

/** ASCII kebab-case slug: "Þingvellir National Park" → "thingvellir-national-park". */
export function slugify(text: string): string {
  return text
    .toLowerCase()
    .replace(/[þðæøœßłđı]/g, (char) => TRANSLITERATION[char] ?? char)
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/['’]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

function isPoiSection(path: readonly string[]): boolean {
  const top = path[0]?.toLowerCase();
  return top !== undefined && (POI_SECTIONS as readonly string[]).includes(top);
}

export function collectPoiCandidates(doc: GuideDocument): PoiCandidate[] {
  const candidates: PoiCandidate[] = [];
  for (const section of doc.sections) {
    if (!isPoiSection(section.path)) continue;
    for (const listing of section.listings) {
      if (!POI_LISTING_TYPES.has(listing.type) || listing.name === '') continue;
      candidates.push({
        name: listing.name,
        description: listing.description,
        sectionPath: section.path,
        source: 'listing',
      });
    }
    for (const block of section.blocks) {
      if (block.type !== 'item' || block.entry === null || block.entry.source === 'listing') {
        continue;
      }
      candidates.push({
        name: block.entry.name,
        description: block.entry.description,
        sectionPath: section.path,
        source: block.entry.source,
      });
    }
  }
  return candidates;
}

export interface PoiExtraction {
  readonly pois: Poi[];
  readonly sources: { listing: number; marker: number; named: number };
  readonly duplicatesDropped: number;
}

/** Turns candidates into schema POIs with stable ids `<destination>-<slug>`; first one wins. */
export function buildPois(
  destinationId: string,
  candidates: readonly PoiCandidate[],
): PoiExtraction {
  const pois: Poi[] = [];
  const seen = new Set<string>();
  const sources = { listing: 0, marker: 0, named: 0 };
  let duplicatesDropped = 0;
  candidates.forEach((candidate, index) => {
    const slug = slugify(candidate.name) || `poi-${index + 1}`;
    const id = `${destinationId}-${slug}`;
    if (seen.has(id)) {
      duplicatesDropped++;
      return;
    }
    seen.add(id);
    sources[candidate.source]++;
    // Markdown emphasis (marker names inside a sentence) is not part of a plain-text description.
    const description = candidate.description?.replace(/\*\*/g, '').trim() ?? '';
    pois.push({
      id,
      name: candidate.name,
      kinds: mapKinds(candidate),
      description: description === '' ? null : description,
      crowd_level: null,
      best_months: [],
      source_ref: candidate.sectionPath.join(' > '),
    });
  });
  return { pois, sources, duplicatesDropped };
}
