import { describe, expect, it } from 'vitest';
import { isLongStayPrice, median, parseAmount, parsePrice, summarisePrices } from './prices.js';

describe('parseAmount', () => {
  it('reads thousands separators and decimals', () => {
    expect(parseAmount('1,200')).toBe(1200);
    expect(parseAmount('1.200')).toBe(1200);
    expect(parseAmount('1 200')).toBe(1200);
    expect(parseAmount('8.50')).toBe(8.5);
    expect(parseAmount('8,50')).toBe(8.5);
    expect(parseAmount('45')).toBe(45);
  });
});

describe('parsePrice', () => {
  it.each([
    ['€50', { currency: '€', min: 50, max: 50 }],
    ['€50-80', { currency: '€', min: 50, max: 80 }],
    ['50–80 €', { currency: '€', min: 50, max: 80 }],
    ['From 450 kr to 1250 kr', { currency: 'kr', min: 450, max: 1250 }],
    ['From 250 kr', { currency: 'kr', min: 250, max: 250 }],
    ['NOK 1,200 per night', { currency: 'NOK', min: 1200, max: 1200 }],
    ['Dorm bed €25, double room €70 (2 persons)', { currency: '€', min: 25, max: 70 }],
    ['ISK 9.990', { currency: 'ISK', min: 9990, max: 9990 }],
    ['£45 (or €55)', { currency: '£', min: 45, max: 45 }],
    ['doubles 60 eur', { currency: 'EUR', min: 60, max: 60 }],
  ])('parses %j', (raw, expected) => {
    expect(parsePrice(raw)).toEqual(expected);
  });

  it.each(['Free', '€€', 'Varies', 'Open 9-17, 2 floors', '20-35 e'])(
    'returns null when no amount carries a currency: %j',
    (raw) => {
      expect(parsePrice(raw)).toBeNull();
    },
  );

  it('ignores years and times next to a price', () => {
    expect(parsePrice('€12 (2019), open 09:00-18:00')).toEqual({ currency: '€', min: 12, max: 12 });
  });
});

describe('isLongStayPrice', () => {
  it('flags weekly and monthly rates', () => {
    expect(isLongStayPrice('From €900/month')).toBe(true);
    expect(isLongStayPrice('€400 per week')).toBe(true);
    expect(isLongStayPrice('weekly rates from €300')).toBe(true);
    expect(isLongStayPrice('€60-90/day per apartment')).toBe(false);
  });
});

describe('median / summarisePrices', () => {
  it('computes the median of odd and even samples', () => {
    expect(median([3, 1, 2])).toBe(2);
    expect(median([4, 1, 3, 2])).toBe(2.5);
    expect(() => median([])).toThrow();
  });

  it('summarises listing midpoints in the majority currency', () => {
    expect(
      summarisePrices([
        { currency: '€', min: 50, max: 80 },
        { currency: '€', min: 30, max: 30 },
        { currency: '€', min: 100, max: 140 },
        { currency: 'kr', min: 900, max: 900 },
      ]),
    ).toEqual({
      median: 65,
      min: 30,
      max: 140,
      currency: '€',
      sample_size: 3,
      excluded_other_currency: 1,
    });
  });

  it('returns null without prices', () => {
    expect(summarisePrices([])).toBeNull();
  });
});
