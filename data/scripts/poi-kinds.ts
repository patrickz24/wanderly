/**
 * Deterministic POI kind mapping: a documented keyword table applied to the POI name, its
 * description and its section heading path (e.g. "See > Museums"). A POI can have several kinds;
 * when no keyword matches it gets `other`. No model, no guess beyond the table below.
 */
import { POI_KINDS, type PoiKind } from '@wanderly/contracts';

/**
 * Keyword table (case-insensitive, matched on word boundaries; `*` = any word ending).
 * Order matters only for the output order of kinds, which follows `POI_KINDS`.
 */
export const KIND_KEYWORDS: Readonly<Record<Exclude<PoiKind, 'other'>, readonly string[]>> = {
  hiking: [
    'hike*',
    'hiking',
    'trek*',
    'trail*',
    'walking',
    'walks',
    'footpath*',
    'gr\\d+',
    'alta via',
    'summit*',
    'mountain hut*',
  ],
  beach: ['beach*', 'cove*', 'sandy', 'swim*', 'lido', 'bathing'],
  nature: [
    'national park*',
    'natural park*',
    'nature park*',
    'nature reserve*',
    'reserve',
    'park',
    'parks',
    'lake*',
    'lagoon*',
    'waterfall*',
    'falls',
    'glacier*',
    'volcan*',
    'crater*',
    'mountain*',
    'forest*',
    'wildlife',
    'bird*',
    'cave*',
    'grotto*',
    'canyon*',
    'gorge*',
    'plateau*',
    'meadow*',
    'geyser*',
    'hot spring*',
    'thermal spring*',
    'cliff*',
    'fjord*',
    'valley*',
    'scenery',
    'nature',
    'archipelago*',
    'garden',
    'gardens',
    'botanic*',
    'cape',
    'capes',
    'islet*',
    'marsh*',
    'wetland*',
    'flora',
    'fauna',
  ],
  historic_site: [
    'castle*',
    'fortress*',
    'fortification*',
    'fort',
    'citadel*',
    'ruin*',
    'archaeolog*',
    'archeolog*',
    'ancient',
    'temple*',
    'palace*',
    'roman',
    'romans',
    'minoan',
    'phoenician',
    'norman',
    'venetian',
    'medieval',
    'necropolis',
    'tomb*',
    'amphitheat*',
    'acropolis',
    'nuraghe*',
    'nuragic',
    'old town',
    'historic*',
    'city walls',
    'tower*',
    'monument*',
    'mosaic*',
    'viking*',
  ],
  museum: ['museum*', 'museo', 'gallery', 'galleries', 'galleri', 'exhibition*', 'art collection*'],
  religious_site: [
    'church*',
    'cathedral*',
    'basilica*',
    'monaster*',
    'convent*',
    'abbey*',
    'chapel*',
    'sanctuar*',
    'santuari*',
    'shrine*',
    'mosque*',
    'synagogue*',
    'duomo',
    'chiesa',
    'pilgrimage*',
  ],
  village: ['village*', 'hamlet*', 'borgo', 'borghi', 'fishing town*', 'small town*'],
  viewpoint: [
    'viewpoint*',
    'panoram*',
    'lookout*',
    'belvedere',
    'miradouro*',
    'mirador*',
    'vista*',
    'sunset*',
    'scenic',
  ],
  boat_trip: [
    'boat trip*',
    'boat tour*',
    'boat excursion*',
    'boat ride*',
    'by boat',
    'cruise*',
    'sailing',
    'yacht*',
    'whale watching',
    'whale-watching',
    'catamaran*',
    'ferry trip*',
  ],
  food: [
    'food',
    'cuisine',
    'restaurant*',
    'gastronom*',
    'market*',
    'cheese*',
    'olive oil',
    'bakery',
    'bakeries',
    'pastr*',
    'seafood',
    'cooking class*',
    'culinary',
  ],
  wine: ['wine*', 'winer*', 'vineyard*', 'cantina*', 'enoteca*', 'vintner*', 'grape*'],
  nightlife: [
    'nightlife',
    'nightclub*',
    'clubbing',
    'disco',
    'discos',
    'discotheque*',
    'bars',
    'pub',
    'pubs',
    'live music',
  ],
  family: [
    'family',
    'family-friendly',
    'kid-friendly',
    'families',
    'child*',
    'kids',
    'zoo',
    'aquarium',
    'theme park*',
    'water park*',
    'amusement*',
  ],
  adventure: [
    'climb*',
    'via ferrata',
    'rafting',
    'canyoning',
    'paraglid*',
    'diving',
    'scuba',
    'snorkel*',
    'kayak*',
    'canoe*',
    'kitesurf*',
    'windsurf*',
    'surf',
    'surfing',
    'ski',
    'skiing',
    'snowboard*',
    'mountain bik*',
    'zip line*',
    'zipline*',
    'adventure*',
    'coasteering',
  ],
};

const escapeRegex = (text: string): string => text.replace(/[.+?^${}()|[\]]/g, '\\$&');

/**
 * `trek*` → any word starting with "trek"; `gr\d+` stays a regex fragment; a space matches any
 * whitespace. Boundaries are Unicode-aware (`\b` is ASCII-only). A hyphen continues a word, so
 * `family` does not match "family-run" while `trail*` still matches "trail-head".
 */
function keywordPattern(keyword: string): string {
  const wildcard = keyword.endsWith('*');
  const stem = wildcard ? keyword.slice(0, -1) : keyword;
  const body = stem.includes('\\d') ? stem : escapeRegex(stem).replace(/ /g, '\\s+');
  const tail = wildcard ? '[\\p{L}\\p{N}-]*' : '';
  return `(?<![\\p{L}\\p{N}])${body}${tail}(?![\\p{L}\\p{N}-])`;
}

const KIND_PATTERNS: readonly (readonly [PoiKind, RegExp])[] = POI_KINDS.filter(
  (kind): kind is Exclude<PoiKind, 'other'> => kind !== 'other',
).map((kind) => [kind, new RegExp(KIND_KEYWORDS[kind].map(keywordPattern).join('|'), 'iu')]);

/**
 * Maps a POI to its kinds. The top-level section titles "See" and "Do" carry no signal and are
 * ignored; subsection titles ("Museums", "Hiking"…) are used like any other text.
 */
export function mapKinds(input: {
  readonly name: string;
  readonly description: string | null;
  readonly sectionPath: readonly string[];
}): PoiKind[] {
  const headings = input.sectionPath.filter((title) => !/^(see|do)$/i.test(title));
  const haystack = [input.name, input.description ?? '', ...headings].join(' \n ');
  const kinds = KIND_PATTERNS.filter(([, pattern]) => pattern.test(haystack)).map(([kind]) => kind);
  return kinds.length > 0 ? kinds : ['other'];
}
