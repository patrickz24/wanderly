import { describe, expect, it } from 'vitest';
import { parseCliArgs } from './cli-args.js';
import { type Destination, DestinationListSchema, selectDestinations } from './destinations.js';

describe('parseCliArgs', () => {
  it('parses --only and allowed flags', () => {
    const options = parseCliArgs(['--latest', '--only', 'sicily'], ['--latest']);
    expect(options.only).toBe('sicily');
    expect([...options.flags]).toEqual(['--latest']);
  });

  it('rejects unknown arguments and a missing --only value', () => {
    expect(() => parseCliArgs(['--force'], ['--latest'])).toThrow(/Unknown argument/);
    expect(() => parseCliArgs(['--only'], [])).toThrow(/requires a destination id/);
    expect(() => parseCliArgs(['--only', '--latest'], ['--latest'])).toThrow(/requires/);
  });
});

describe('destinations', () => {
  const destination = (id: string): Destination => ({
    id,
    name: id,
    country: 'Italy',
    wikivoyage_title: id,
    aliases: [],
    climate_point: { lat: 1, lon: 2, source: 'test' },
  });

  it('rejects duplicate ids and non-slug ids', () => {
    const result = DestinationListSchema.safeParse({
      destinations: [destination('sicily'), destination('sicily'), destination('Bad Id')],
    });
    expect(result.success).toBe(false);
    expect(result.error?.issues.map((issue) => issue.message)).toEqual(
      expect.arrayContaining(['duplicate destination id "sicily"', 'id must be a kebab-case slug']),
    );
  });

  it('selects one destination or fails on an unknown id', () => {
    const all = [destination('sicily'), destination('crete')];
    expect(selectDestinations(all, 'crete').map((d) => d.id)).toEqual(['crete']);
    expect(selectDestinations(all, null)).toHaveLength(2);
    expect(() => selectDestinations(all, 'atlantis')).toThrow(/Unknown destination/);
  });
});
