import { describe, expect, it } from 'vitest';
import { type Facts, FactsSchema } from './facts-schema.js';
import { GuideFrontMatterSchema } from './guide-schema.js';

const month = (m: number): Facts['climate']['months'][number] => ({
  month: m,
  avg_high_c: 20,
  avg_low_c: 10,
  rain_days: 3.5,
  precipitation_mm: 40.2,
});

const emptyLevel = { lodging_night: null, meal: null, notes: ['value unknown'] };

const valid: Facts = {
  schema_version: 1,
  id: 'sicily',
  name: 'Sicily',
  country: 'Italy',
  aliases: ['Sicile'],
  is_part_of: ['Italy'],
  source: {
    guide: 'guide.md',
    title: 'Sicily',
    url: 'https://en.wikivoyage.org/wiki/Sicily',
    revision_id: 1,
    license: 'CC BY-SA 4.0',
  },
  climate: {
    provider: 'Open-Meteo Historical Weather API',
    model: 'era5_seamless',
    period: { start: '2015-01-01', end: '2024-12-31' },
    point: { lat: 38.1, lon: 13.4, source: 'test' },
    grid_cell: { lat: 38.1, lon: 13.4, elevation_m: 20 },
    license: 'CC BY 4.0',
    attribution: 'Weather data by Open-Meteo.com',
    months: Array.from({ length: 12 }, (_, index) => month(index + 1)),
  },
  costs: {
    derivation: 'listing prices only',
    overall: emptyLevel,
    levels: { budget: emptyLevel, mid: emptyLevel, comfort: emptyLevel },
  },
  pois: [
    {
      id: 'sicily-mount-etna',
      name: 'Mount Etna',
      kinds: ['nature'],
      description: null,
      crowd_level: null,
      best_months: [],
      source_ref: 'Other destinations',
    },
  ],
  extraction: {
    listings: 0,
    listings_by_type: {},
    priced_listings: { sleep: 0, eat: 0 },
    poi_sources: { listing: 0, marker: 1, named: 0 },
    duplicate_pois_dropped: 0,
  },
};

const issues = (data: unknown): string[] => {
  const result = FactsSchema.safeParse(data);
  return result.success ? [] : result.error.issues.map((issue) => issue.message);
};

describe('FactsSchema', () => {
  it('accepts a valid facts document', () => {
    expect(issues(valid)).toEqual([]);
  });

  it('rejects POIs whose id is not prefixed by the destination, or duplicated', () => {
    const poi = valid.pois[0]!;
    const result = issues({ ...valid, pois: [{ ...poi, id: 'etna' }, poi, poi] });
    expect(result).toContain('POI id must start with "sicily-"');
    expect(result).toContain('duplicate POI id');
  });

  it('rejects unordered months, inverted temperatures and unknown kinds', () => {
    const months = valid.climate.months.map((m) => ({ ...m }));
    [months[0], months[1]] = [months[1]!, months[0]!];
    months[5] = { ...month(6), avg_low_c: 30 };
    expect(issues({ ...valid, climate: { ...valid.climate, months } })).toEqual(
      expect.arrayContaining([
        'months must be ordered 1..12 (found 2 at position 1)',
        'avg_low_c is above avg_high_c',
      ]),
    );
    expect(issues({ ...valid, pois: [{ ...valid.pois[0]!, kinds: ['castle'] }] })).toHaveLength(1);
  });

  it('rejects invented crowd levels and months out of range, and unknown fields', () => {
    const poi = { ...valid.pois[0]!, crowd_level: 6, best_months: [13] };
    expect(issues({ ...valid, pois: [poi] })).toHaveLength(2);
    expect(issues({ ...valid, rating: 5 })).toHaveLength(1);
  });
});

describe('GuideFrontMatterSchema', () => {
  it('requires provenance and licence fields', () => {
    const frontMatter = {
      id: 'sicily',
      title: 'Sicily',
      source_url: 'https://en.wikivoyage.org/wiki/Sicily',
      revision_id: 5320270,
      revision_timestamp: '2026-07-31T17:00:44Z',
      revision_url: 'https://en.wikivoyage.org/w/index.php?title=Sicily&oldid=5320270',
      retrieved_at: '2026-10-09T13:45:42.403Z',
      license: 'CC BY-SA 4.0',
      license_url: 'https://creativecommons.org/licenses/by-sa/4.0/deed.en',
      attribution: '"Sicily" by Wikivoyage contributors',
      is_part_of: ['Italy'],
    };
    expect(GuideFrontMatterSchema.safeParse(frontMatter).success).toBe(true);
    const { license: _license, ...withoutLicense } = frontMatter;
    expect(GuideFrontMatterSchema.safeParse(withoutLicense).success).toBe(false);
  });
});
