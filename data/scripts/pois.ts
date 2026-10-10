/**
 * POI extraction from converted guides (pure).
 *
 * Sources, in document order (documented in data/README.md), from the See, Do and Other
 * destinations sections of the region guide and of each place article:
 * - `listing`: see/do/event/listing templates;
 * - `marker`: `{{marker}}` list items (region articles name their attractions this way);
 * - `named`: list items that start with a bold or linked name
 *   (`* '''Valldemossa''' Charterhouse was…`), except generic ones (see `isGenericName`).
 * Cities/towns, regions, and Get in / Eat / Sleep listings are not POIs.
 */
import type { Poi } from '@wanderly/contracts';
import { mapKinds } from './poi-kinds.js';
import { curate, evidencePool } from './curation.js';
import { type GuideDocument, renderListing, sectionText } from './wikitext.js';

export const POI_SECTIONS = ['see', 'do', 'other destinations'] as const;
const POI_LISTING_TYPES = new Set(['see', 'do', 'event', 'listing']);

/** The document a candidate comes from: the region guide (placeId null) or a place article. */
export interface SourceDocument {
  readonly title: string;
  readonly placeId: string | null;
}

export interface PoiCandidate {
  readonly name: string;
  readonly description: string | null;
  readonly sectionPath: readonly string[];
  readonly source: 'listing' | 'marker' | 'named';
  readonly document: SourceDocument;
  /** Verbatim sentences about the POI, read by the curation lexicons (see curation.ts). */
  readonly evidence?: readonly string[];
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
    .replace(/[̀-ͯ]/g, '')
    .replace(/['’]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

/**
 * Words that name an activity or a category rather than a place ("Golf", "Churches",
 * "Whale and dolphin watching", "Rent a scooter"). Kept explicit so that every pruning decision
 * can be traced to this list.
 */
export const GENERIC_TERMS: ReadonlySet<string> = new Set([
  // activities
  'activities',
  'adventure',
  'bathing',
  'bike',
  'bikes',
  'biking',
  'bird',
  'birds',
  'birdwatching',
  'boat',
  'boating',
  'boats',
  'canoeing',
  'canyoning',
  'circuits',
  'classes',
  'climb',
  'climbing',
  'concerts',
  'cooking',
  'cruise',
  'cruises',
  'cycling',
  'diving',
  'dolphin',
  'dolphins',
  'donkey',
  'excursions',
  'fishing',
  'football',
  'golf',
  'guided',
  'hike',
  'hikes',
  'hiking',
  'hire',
  'horse',
  'kayaking',
  'kiting',
  'kitesurfing',
  'moto',
  'mountain',
  'music',
  'nightlife',
  'off',
  'outdoor',
  'quad',
  'rafting',
  'rent',
  'rental',
  'ride',
  'rides',
  'riding',
  'road',
  'rock',
  'sailing',
  'scooter',
  'scuba',
  'shopping',
  'sightseeing',
  'ski',
  'skiing',
  'snorkeling',
  'snorkelling',
  'snowboarding',
  'spa',
  'spas',
  'sport',
  'sports',
  'surf',
  'surfing',
  'swimming',
  'tasting',
  'tennis',
  'tour',
  'tours',
  'trekking',
  'trips',
  'walk',
  'walking',
  'walks',
  'watching',
  'water',
  'wellness',
  'whale',
  'whales',
  'windsurfing',
  'yachting',
  // events and culture in general
  'carnival',
  'events',
  'festival',
  'festivals',
  'fiestas',
  'flamenco',
  'theatre',
  // categories of places
  'archaeological',
  'archeological',
  'architecture',
  'attractions',
  'baths',
  'beach',
  'beaches',
  'castles',
  'cave',
  'caves',
  'churches',
  'cities',
  'convents',
  'gardens',
  'glacier',
  'hot',
  'islands',
  'lakes',
  'markets',
  'miradouro',
  'miradouros',
  'monasteries',
  'mountains',
  'museums',
  'nature',
  'old',
  'parks',
  'pool',
  'pools',
  'scenery',
  'site',
  'sites',
  'springs',
  'square',
  'thermal',
  'town',
  'towns',
  'traditional',
  'viewpoints',
  'views',
  'villages',
  'wine',
  'wineries',
  // connectors and generic transport
  'a',
  'an',
  'and',
  'at',
  'by',
  'car',
  'ferry',
  'for',
  'in',
  'of',
  'on',
  'or',
  'the',
  'to',
  'with',
]);

/**
 * True when every word of the name (case-insensitive, numbers ignored) is in GENERIC_TERMS: the
 * item is a heading for an activity or a category ("Churches", "Moto 4 Rides"), not a place.
 * A single specific word keeps it ("Palma old town", "Volcano Climbing at Pico island").
 */
export function isGenericName(name: string): boolean {
  const words = name
    .toLowerCase()
    .split(/[^\p{L}\p{N}]+/u)
    .filter((word) => word !== '' && !/^\p{N}+$/u.test(word));
  return words.every((word) => GENERIC_TERMS.has(word));
}

function isPoiSection(path: readonly string[]): boolean {
  const top = path[0]?.toLowerCase();
  return top !== undefined && (POI_SECTIONS as readonly string[]).includes(top);
}

export interface CandidateCollection {
  readonly candidates: PoiCandidate[];
  /** Named items left out by isGenericName. */
  readonly genericPruned: number;
}

export function collectPoiCandidates(
  doc: GuideDocument,
  document: SourceDocument = { title: doc.title, placeId: null },
): CandidateCollection {
  const candidates: PoiCandidate[] = [];
  let genericPruned = 0;
  for (const section of doc.sections) {
    if (!isPoiSection(section.path)) continue;
    const sectionMarkdown = sectionText(section);
    const paragraphs = section.blocks.flatMap((block) =>
      block.type === 'paragraph' ? [block.text] : [],
    );
    const pool = (name: string, ownText: string): string[] =>
      evidencePool({ name, ownText, paragraphs, sectionMarkdown });
    for (const listing of section.listings) {
      if (!POI_LISTING_TYPES.has(listing.type) || listing.name === '') continue;
      candidates.push({
        name: listing.name,
        description: listing.description,
        sectionPath: section.path,
        source: 'listing',
        document,
        evidence: pool(listing.name, renderListing(listing)),
      });
    }
    for (const block of section.blocks) {
      if (block.type !== 'item' || block.entry === null || block.entry.source === 'listing') {
        continue;
      }
      if (block.entry.source === 'named' && isGenericName(block.entry.name)) {
        genericPruned++;
        continue;
      }
      candidates.push({
        name: block.entry.name,
        description: block.entry.description,
        sectionPath: section.path,
        source: block.entry.source,
        document,
        evidence: pool(block.entry.name, block.text),
      });
    }
  }
  return { candidates, genericPruned };
}

export interface PoiExtraction {
  readonly pois: Poi[];
  readonly sources: { listing: number; marker: number; named: number };
  readonly duplicatesDropped: number;
}

/**
 * Turns candidates into schema POIs. Ids are stable: `<destination>-<slug>` for the region guide
 * and `<destination>-<place-id>-<slug>` for a place article; the first candidate with a given id
 * wins. `source_ref` is the document title followed by the heading path. `crowd_level` and
 * `best_months` come from the lexical curation of the POI's own sentences, with their evidence.
 */
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
    const prefix =
      candidate.document.placeId === null
        ? destinationId
        : `${destinationId}-${candidate.document.placeId}`;
    const id = `${prefix}-${slug}`;
    if (seen.has(id)) {
      duplicatesDropped++;
      return;
    }
    seen.add(id);
    sources[candidate.source]++;
    // Markdown emphasis (marker names inside a sentence) is not part of a plain-text description.
    const description = candidate.description?.replace(/\*\*/g, '').trim() ?? '';
    const curation = curate(candidate.evidence ?? []);
    pois.push({
      id,
      name: candidate.name,
      kinds: mapKinds(candidate),
      description: description === '' ? null : description,
      crowd_level: curation.crowd_level,
      best_months: curation.best_months,
      source_ref: [candidate.document.title, ...candidate.sectionPath].join(' > '),
      crowd_evidence: curation.crowd_evidence,
      months_evidence: curation.months_evidence,
    });
  });
  return { pois, sources, duplicatesDropped };
}
