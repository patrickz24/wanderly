import { describe, expect, it } from 'vitest';
import { COST_LEVELS, type Facts, FactsSchema, GuideFrontMatterSchema } from './corpus.js';

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

describe('COST_LEVELS', () => {
  it("uses the agent's budget vocabulary", () => {
    expect(COST_LEVELS).toEqual(['budget', 'mid', 'comfort']);
  });
});

describe('corpus documents', () => {
  const region = {
    file: 'guide.md',
    role: 'region' as const,
    id: 'sicily',
    title: 'Sicily',
    url: 'https://en.wikivoyage.org/wiki/Sicily',
    revision_id: 1,
    license: 'CC BY-SA 4.0',
  };
  const place = {
    ...region,
    file: 'places/palermo.md',
    role: 'place' as const,
    id: 'palermo',
    title: 'Palermo',
  };

  it('accepts facts with or without the list of source documents', () => {
    expect(FactsSchema.safeParse({ ...valid, documents: [region, place] }).success).toBe(true);
    expect(FactsSchema.safeParse(valid).success).toBe(true);
  });

  it('requires the region guide first and distinct place articles after it', () => {
    expect(FactsSchema.safeParse({ ...valid, documents: [place, region] }).success).toBe(false);
    expect(FactsSchema.safeParse({ ...valid, documents: [region, place, place] }).success).toBe(
      false,
    );
    expect(
      FactsSchema.safeParse({ ...valid, documents: [{ ...region, revision_id: 2 }] }).success,
    ).toBe(false);
    expect(
      FactsSchema.safeParse({ ...valid, documents: [region, { ...place, file: '../x.md' }] })
        .success,
    ).toBe(false);
  });

  it('accepts the generic-items counter and a parent on place front matter', () => {
    const extraction = { ...valid.extraction, generic_items_pruned: 3 };
    expect(FactsSchema.safeParse({ ...valid, extraction }).success).toBe(true);
    const frontMatter = {
      id: 'palermo',
      title: 'Palermo',
      source_url: 'https://en.wikivoyage.org/wiki/Palermo',
      revision_id: 5354768,
      revision_timestamp: '2026-09-01T10:00:00Z',
      revision_url: 'https://en.wikivoyage.org/w/index.php?title=Palermo&oldid=5354768',
      retrieved_at: '2026-10-10T10:00:00.000Z',
      license: 'CC BY-SA 4.0',
      license_url: 'https://creativecommons.org/licenses/by-sa/4.0/deed.en',
      attribution: '"Palermo" by Wikivoyage contributors',
      is_part_of: ['Palermo (province)'],
      parent: 'sicily',
    };
    expect(GuideFrontMatterSchema.safeParse(frontMatter).success).toBe(true);
    expect(GuideFrontMatterSchema.safeParse({ ...frontMatter, parent: 'Not A Slug' }).success).toBe(
      false,
    );
  });
});

describe('POI curation evidence', () => {
  const poi = valid.pois[0]!;
  const withPoi = (changes: object): unknown => ({ ...valid, pois: [{ ...poi, ...changes }] });

  it('accepts curated values with their evidence, and files without evidence fields', () => {
    expect(
      FactsSchema.safeParse(
        withPoi({
          crowd_level: 4,
          crowd_evidence: ['Very crowded in August.'],
          best_months: [4, 5],
          months_evidence: ['Best in April and May.'],
        }),
      ).success,
    ).toBe(true);
    expect(
      FactsSchema.safeParse(withPoi({ crowd_evidence: [], months_evidence: [] })).success,
    ).toBe(true);
    expect(FactsSchema.safeParse(valid).success).toBe(true);
  });

  it('rejects a value without evidence and evidence without a value', () => {
    expect(FactsSchema.safeParse(withPoi({ crowd_level: 4, crowd_evidence: [] })).success).toBe(
      false,
    );
    expect(FactsSchema.safeParse(withPoi({ months_evidence: ['Best in May.'] })).success).toBe(
      false,
    );
  });
});
