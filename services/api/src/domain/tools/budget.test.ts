import { describe, expect, it } from 'vitest';
import { COSTS } from '../../../test/support/agent-fakes.js';
import type { CostFacts, CostFigure } from '../ports/knowledge.js';
import { estimateBudget, round2 } from './budget.js';

const sicily = COSTS[0]!;
const figure = (median: number, currency = 'EUR'): CostFigure => ({
  median,
  min: median,
  max: median,
  currency,
  sampleSize: 3,
});
const withLevel = (lodgingNight: CostFigure | null, meal: CostFigure | null): CostFacts => ({
  ...sicily,
  levels: { ...sicily.levels, mid: { lodgingNight, meal, notes: [] } },
});

describe('estimateBudget', () => {
  it('computes nights × rooms × lodging + meals × days × travellers', () => {
    const estimate = estimateBudget(sicily, {
      destinationId: 'sicily',
      days: 5,
      travelers: 3,
      level: 'mid',
    });
    // 4 nights × 2 rooms × 100 + 2 meals × 5 days × 3 travellers × 25
    expect(estimate).toMatchObject({
      nights: 4,
      rooms: 2,
      currency: 'EUR',
      lodging: { perNight: 100, nights: 4, rooms: 2, subtotal: 800, sampleSize: 4 },
      meals: { perMeal: 25, mealsPerDay: 2, days: 5, travelers: 3, subtotal: 750 },
      total: 1550,
      perPerson: 516.67,
    });
    expect(estimate.notes[0]).toContain(
      'Assumes 4 night(s) for 5 day(s), 2 room(s) for 3 traveller(s)',
    );
  });

  it('has no lodging cost for a one-day trip', () => {
    const estimate = estimateBudget(sicily, {
      destinationId: 'sicily',
      days: 1,
      travelers: 1,
      level: 'budget',
    });
    expect(estimate).toMatchObject({ nights: 0, total: 24, perPerson: 24 });
    expect(estimate.lodging?.subtotal).toBe(0);
  });

  it('returns null figures with explicit notes when the guide has no cost data', () => {
    const estimate = estimateBudget(null, {
      destinationId: 'crete',
      days: 3,
      travelers: 2,
      level: 'mid',
    });
    expect(estimate).toMatchObject({
      currency: null,
      lodging: null,
      meals: null,
      total: null,
      perPerson: null,
    });
    expect(estimate.notes).toContain('The guide has no cost information for this destination.');
  });

  it('keeps the known part but gives no total when a figure is missing', () => {
    const estimate = estimateBudget(sicily, {
      destinationId: 'sicily',
      days: 3,
      travelers: 2,
      level: 'comfort',
    });
    expect(estimate).toMatchObject({
      lodging: null,
      currency: 'EUR',
      total: null,
      perPerson: null,
    });
    expect(estimate.meals?.subtotal).toBe(720);
    expect(estimate.notes).toEqual(
      expect.arrayContaining([
        'No splurge lodging listing.',
        'No comfort lodging price in the guide.',
        'Only part of the budget has a price in the guide, so there is no total.',
      ]),
    );
  });

  it('never converts currencies', () => {
    const estimate = estimateBudget(withLevel(figure(80, 'EUR'), figure(1500, 'ISK')), {
      destinationId: 'sicily',
      days: 2,
      travelers: 2,
      level: 'mid',
    });
    expect(estimate).toMatchObject({ currency: null, total: null, perPerson: null });
    expect(estimate.lodging?.currency).toBe('EUR');
    expect(estimate.meals?.currency).toBe('ISK');
    expect(estimate.notes.join(' ')).toContain('no conversion is made');
  });

  it('reports no figure at all when the level has none', () => {
    const estimate = estimateBudget(withLevel(null, null), {
      destinationId: 'sicily',
      days: 2,
      travelers: 2,
      level: 'mid',
    });
    expect(estimate).toMatchObject({ currency: null, total: null });
    expect(estimate.notes).toEqual(
      expect.arrayContaining([
        'No mid lodging price in the guide.',
        'No mid meal price in the guide.',
      ]),
    );
  });

  it('returns a frozen result', () => {
    const estimate = estimateBudget(sicily, {
      destinationId: 'sicily',
      days: 2,
      travelers: 2,
      level: 'mid',
    });
    expect(Object.isFrozen(estimate)).toBe(true);
    expect(Object.isFrozen(estimate.notes)).toBe(true);
  });
});

describe('round2', () => {
  it('rounds to cents without floating-point noise', () => {
    expect(round2(0.1 + 0.2)).toBe(0.3);
    expect(round2(516.6666)).toBe(516.67);
  });
});
