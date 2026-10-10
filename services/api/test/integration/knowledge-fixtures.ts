import { createHash } from 'node:crypto';
import { FactsSchema, type Facts } from '@wanderly/contracts';
import type {
  Corpus,
  CorpusDestination,
  CorpusDocument,
  CorpusSource,
} from '../../src/application/ports/corpus-source.js';

/** Small, valid corpus objects for the knowledge integration tests. */

const emptyLevel = { lodging_night: null, meal: null, notes: ['no priced listing'] };

export function makeFacts(
  id: string,
  overrides: Partial<Record<keyof Facts, unknown>> = {},
): Facts {
  const name = id.charAt(0).toUpperCase() + id.slice(1);
  return FactsSchema.parse({
    schema_version: 1,
    id,
    name,
    country: 'Testland',
    aliases: [`${name}-alias`],
    is_part_of: ['Europe'],
    source: {
      guide: 'guide.md',
      title: name,
      url: `https://en.wikivoyage.org/wiki/${name}`,
      revision_id: 1,
      license: 'CC BY-SA 4.0',
    },
    climate: {
      provider: 'Open-Meteo',
      model: 'era5_seamless',
      period: { start: '2015-01-01', end: '2024-12-31' },
      point: { lat: 1, lon: 1, source: 'test' },
      grid_cell: { lat: 1, lon: 1, elevation_m: 0 },
      license: 'CC BY 4.0',
      attribution: 'Weather data by Open-Meteo.com',
      months: Array.from({ length: 12 }, (_, index) => ({
        month: index + 1,
        avg_high_c: 10 + index,
        avg_low_c: 5 + index / 2,
        rain_days: 3.5,
        precipitation_mm: 40.2,
      })),
    },
    costs: {
      derivation: 'medians of listing prices',
      overall: emptyLevel,
      levels: { budget: emptyLevel, mid: emptyLevel, comfort: emptyLevel },
    },
    pois: [],
    extraction: {
      listings: 0,
      listings_by_type: {},
      priced_listings: { sleep: 0, eat: 0 },
      poi_sources: { listing: 0, marker: 0, named: 0 },
      duplicate_pois_dropped: 0,
    },
    ...overrides,
  });
}

export function makeDocument(
  path: string,
  body: string,
  overrides: Partial<CorpusDocument> = {},
): CorpusDocument {
  const destinationId = path.split('/')[0] ?? 'unknown';
  const name = destinationId.charAt(0).toUpperCase() + destinationId.slice(1);
  return {
    path,
    destinationId,
    role: path.includes('/places/') ? 'place' : 'region',
    title: name,
    breadcrumbRoot: name,
    sourceUrl: `https://en.wikivoyage.org/w/index.php?title=${name}&oldid=1`,
    license: 'CC BY-SA 4.0',
    attribution: `"${name}" by Wikivoyage contributors`,
    body,
    checksum: createHash('sha256').update(body).digest('hex'),
    ...overrides,
  };
}

export function makeDestination(
  facts: Facts,
  documents: CorpusDocument[],
  factsAsOf = '2026-07-31',
): CorpusDestination {
  return { facts, factsAsOf, documents };
}

/** A corpus source whose content tests can change between ingestion runs. */
export class MutableCorpusSource implements CorpusSource {
  constructor(public corpus: Corpus) {}

  async load(): Promise<Corpus> {
    return this.corpus;
  }
}

export const SICILY_GUIDE = [
  '# Sicily',
  '## Overview',
  'Sicily is the largest island in the Mediterranean Sea, known for Greek temples and volcanoes.',
  '## See',
  '### Archaeology',
  'The Valley of the Temples in Agrigento holds some of the best preserved Greek temples outside Greece.',
  '## Do',
  '### Hiking',
  'Mount Etna offers volcanic hikes; guided summit tours leave from Rifugio Sapienza in summer.',
  '### Beaches',
  'San Vito Lo Capo has a long sandy beach with shallow turquoise water, ideal for families.',
  '## Eat',
  'Arancini, cannoli and pasta alla Norma are the island classics; Palermo street food is famous.',
].join('\n\n');

export const CRETE_GUIDE = [
  '# Crete',
  '## Overview',
  'Crete is the largest Greek island, with Minoan palaces, gorges and long beaches.',
  '## Do',
  '### Hiking',
  'The Samaria Gorge is a 16 km hike from the White Mountains down to the Libyan Sea.',
  '### Beaches',
  'Elafonissi has pink sand and a shallow lagoon; it gets very crowded in August.',
  '## Get around',
  'Buses (KTEL) link the northern towns; a rental car is needed for the south coast.',
].join('\n\n');

export const PALERMO_PLACE = [
  '# Palermo',
  '## See',
  'The Ballarò market and the Norman Palace with the Palatine Chapel mosaics are highlights.',
].join('\n\n');
