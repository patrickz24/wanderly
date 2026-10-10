/**
 * Place articles (cities, towns, islands, parks) attached to a destination (pure functions).
 *
 * Wikivoyage region articles describe their destinations in prose and keep listings (sights with
 * descriptions, hotels and restaurants with prices) on the pages of the places they list. The
 * corpus therefore adds, per destination, up to MAX_PLACES place articles chosen by this rule:
 *
 * 1. Candidates are the pages linked from the destination-listing sections of the region article,
 *    i.e. the sections before "Understand" (Regions, Cities, Towns, Islands, Other destinations):
 *    `{{marker}}` names (also inside region lists), `{{Regionlist}}` names and items, and the
 *    first link of each list item.
 * 2. A candidate must be a city, park or rural-area article (Wikivoyage status template), must not
 *    be the destination itself, and must have at least MIN_PRICED priced Sleep/Eat listings or
 *    MIN_SEE_DO See/Do listings.
 * 3. Candidates are ranked by: priced Sleep/Eat listings under Budget / Mid-range / Splurge
 *    subsections, then all priced Sleep/Eat listings, then See/Do listings (all descending), then
 *    title (ascending).
 */
import { levelOf } from './costs.js';
import { isLongStayPrice, parsePrice } from './prices.js';
import { slugify } from './pois.js';
import { type GuideDocument, collectListings } from './wikitext.js';
import { stringify } from 'yaml';
import { findTemplates, param } from './wikitext-templates.js';

export const MAX_PLACES = 4;
export const MIN_PRICED = 3;
export const MIN_SEE_DO = 5;

const PLACE_TYPES = new Set(['city', 'park', 'ruralarea']);
const STATUS =
  /\{\{\s*(?:stub|outline|usable|guide|star)\s?(city|park|ruralarea|region|country|continent|district|airport|itinerary|topic|travel topic|dive guide|phrasebook|event)\b/i;
const LINK = /\[\[([^[\]|#]+)(?:#[^[\]|]*)?(?:\|[^[\]]*)?\]\]/g;

/** "syracuse_(italy)" → "Syracuse (italy)": MediaWiki capitalises the first letter only. */
export function normaliseTitle(raw: string): string {
  const title = raw.replace(/_/g, ' ').replace(/\s+/g, ' ').trim();
  return title.charAt(0).toUpperCase() + title.slice(1);
}

function linkTargets(text: string): string[] {
  return [...text.matchAll(LINK)]
    .map((match) => match[1] ?? '')
    .filter((target) => target.trim() !== '' && !target.includes(':'))
    .map(normaliseTitle);
}

/** The part of a region article before its "Understand" section (where places are listed). */
function listingPart(wikitext: string): string {
  const understand = /^==\s*Understand\s*==\s*$/im.exec(wikitext);
  return understand === null ? wikitext : wikitext.slice(0, understand.index);
}

/** Candidate place titles linked from the destination-listing sections, in document order. */
export function candidateTitles(wikitext: string): string[] {
  const part = listingPart(wikitext);
  const titles: string[] = [];
  const visit = (text: string): void => {
    for (const call of findTemplates(text)) {
      if (call.name === 'marker') titles.push(...linkTargets(param(call, 'name') ?? ''));
      for (const [key, value] of call.params) {
        if (call.name === 'regionlist' && /^region\d+(name|items)$/.test(key)) {
          titles.push(...linkTargets(value));
        }
        visit(value);
      }
    }
  };
  visit(part);
  for (const line of part.split('\n')) {
    if (!/^\s*[*#]/.test(line) || /\{\{\s*marker/i.test(line)) continue;
    const [first] = linkTargets(line);
    if (first !== undefined) titles.push(first);
  }
  return [...new Set(titles)];
}

/** Article type from its status template (`{{usablecity}}` → "city"), or null. */
export function articleType(wikitext: string): string | null {
  const match = STATUS.exec(wikitext);
  return match?.[1] === undefined ? null : match[1].toLowerCase().replace(/\s/g, '');
}

export interface PlaceMetrics {
  readonly seeDoListings: number;
  readonly pricedSleepEat: number;
  /** Priced Sleep/Eat listings under Budget / Mid-range / Splurge subsections. */
  readonly pricedInLevels: number;
  readonly listings: number;
}

export function measurePlace(doc: GuideDocument): PlaceMetrics {
  let seeDoListings = 0;
  let pricedSleepEat = 0;
  let pricedInLevels = 0;
  const listings = collectListings(doc);
  for (const { listing, path } of listings) {
    const top = path[0]?.toLowerCase();
    if ((top === 'see' || top === 'do') && listing.name !== '') seeDoListings++;
    if (
      (top === 'sleep' || top === 'eat') &&
      listing.price !== null &&
      parsePrice(listing.price) !== null &&
      !(top === 'sleep' && isLongStayPrice(listing.price))
    ) {
      pricedSleepEat++;
      if (levelOf(path) !== null) pricedInLevels++;
    }
  }
  return { seeDoListings, pricedSleepEat, pricedInLevels, listings: listings.length };
}

export interface Candidate {
  readonly title: string;
  readonly type: string | null;
  readonly metrics: PlaceMetrics;
}

export type Verdict = 'selected' | 'eligible' | 'wrong type' | 'too few listings';

export function isEligible(candidate: Candidate): boolean {
  return (
    candidate.type !== null &&
    PLACE_TYPES.has(candidate.type) &&
    (candidate.metrics.pricedSleepEat >= MIN_PRICED ||
      candidate.metrics.seeDoListings >= MIN_SEE_DO)
  );
}

export function compareCandidates(a: Candidate, b: Candidate): number {
  return (
    b.metrics.pricedInLevels - a.metrics.pricedInLevels ||
    b.metrics.pricedSleepEat - a.metrics.pricedSleepEat ||
    b.metrics.seeDoListings - a.metrics.seeDoListings ||
    a.title.localeCompare(b.title)
  );
}

/** Applies the rule: eligible candidates, ranked, at most `max`. */
export function selectPlaces(
  candidates: readonly Candidate[],
  max: number = MAX_PLACES,
): { readonly candidate: Candidate; readonly verdict: Verdict }[] {
  const ranked = [...candidates].sort(compareCandidates);
  let selected = 0;
  return ranked.map((candidate) => {
    if (candidate.type === null || !PLACE_TYPES.has(candidate.type)) {
      return { candidate, verdict: 'wrong type' as const };
    }
    if (!isEligible(candidate)) return { candidate, verdict: 'too few listings' as const };
    selected++;
    return { candidate, verdict: selected <= max ? ('selected' as const) : ('eligible' as const) };
  });
}

/** Place id used for file names and POI ids: "Syracuse (Italy)" → "syracuse-italy". */
export const placeId = (title: string): string => slugify(title);

/**
 * Writes the `places:` block of one entry of destinations.yaml, replacing the previous one, and
 * leaves every other line untouched (comments, folded text, quoting).
 */
export function setPlacesBlock(
  yamlText: string,
  destinationId: string,
  places: readonly { readonly id: string; readonly title: string }[],
): string {
  const lines = yamlText.split('\n');
  const start = lines.indexOf(`  - id: ${destinationId}`);
  if (start < 0) throw new Error(`destinations.yaml has no entry "${destinationId}"`);
  const next = lines.findIndex((line, index) => index > start && line.startsWith('  - id: '));
  let end = next < 0 ? lines.length : next;
  while (end > start && (lines[end - 1] ?? '').trim() === '') end--;
  const entry = lines.slice(start, end);
  const existing = entry.findIndex((line) => /^ {4}places:/.test(line));
  let kept = entry;
  if (existing >= 0) {
    let blockEnd = existing + 1;
    while (blockEnd < entry.length && /^ {6}/.test(entry[blockEnd] ?? '')) blockEnd++;
    kept = [...entry.slice(0, existing), ...entry.slice(blockEnd)];
  }
  const block =
    places.length === 0
      ? ['    places: []']
      : [
          '    places:',
          ...places.flatMap((place) => [
            `      - id: ${place.id}`,
            `        title: ${stringify(place.title).trim()}`,
          ]),
        ];
  return [...lines.slice(0, start), ...kept, ...block, ...lines.slice(end)].join('\n');
}
