import { describe, expect, it } from 'vitest';
import {
  destinationName,
  formatDuration,
  formatMoney,
  formatUsd,
  monthName,
  plural,
} from './format';

describe('format', () => {
  it('names months', () => {
    expect([1, 5, 12].map(monthName)).toEqual(['January', 'May', 'December']);
  });

  it('turns destination ids into names', () => {
    expect(destinationName('sicily')).toBe('Sicily');
    expect(destinationName('seiser-alm')).toBe('Seiser Alm');
  });

  it('pluralises', () => {
    expect(plural(1, 'day')).toBe('1 day');
    expect(plural(5, 'day')).toBe('5 days');
    expect(plural(0, 'source')).toBe('0 sources');
  });

  it.each([
    [420, '420 ms'],
    [1530, '1.5 s'],
    [24_310, '24.3 s'],
    [60_000, '1 min'],
    [65_000, '1 min 5 s'],
  ])('formats %i ms as %s', (ms, text) => {
    expect(formatDuration(ms)).toBe(text);
  });

  it('shows run costs with enough precision', () => {
    expect(formatUsd(0.0368)).toBe('$0.0368');
    expect(formatUsd(0)).toBe('$0.00');
    expect(formatUsd(1.5)).toBe('$1.50');
  });

  it('formats money in the currency as written, without conversion', () => {
    expect(formatMoney(1200, 'EUR')).toBe('€1,200');
    expect(formatMoney(1200, '€')).toBe('1,200 €');
    expect(formatMoney(950, 'kr')).toBe('950 kr');
    expect(formatMoney(10, 'XYZ')).toMatch(/10/);
  });
});
