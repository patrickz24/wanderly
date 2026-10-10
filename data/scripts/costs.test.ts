import { describe, expect, it } from 'vitest';
import { deriveCosts, levelOf } from './costs.js';
import { convertArticle } from './wikitext.js';

describe('levelOf', () => {
  it('maps Wikivoyage price subsections to levels', () => {
    expect(levelOf(['Sleep', 'Budget'])).toBe('budget');
    expect(levelOf(['Eat', 'Mid-range'])).toBe('mid');
    expect(levelOf(['Sleep', 'Splurge'])).toBe('comfort');
    expect(levelOf(['Sleep', 'Camping'])).toBeNull();
    expect(levelOf(['Sleep'])).toBeNull();
  });
});

describe('deriveCosts', () => {
  it('derives per-level medians only from listing prices', () => {
    const doc = convertArticle(
      'Town',
      [
        '==Eat==',
        '===Budget===',
        '* {{eat|name=A|price=€8}}',
        '* {{eat|name=B|price=€10-14}}',
        '===Splurge===',
        '* {{eat|name=C|price=Tasting menu €90}}',
        '==Sleep==',
        '===Budget===',
        '* {{sleep|name=D|price=Dorms €25}}',
        '* {{sleep|name=E|price=€30}}',
        '* {{sleep|name=F|price=Free for guests of G}}',
        '* {{sleep|name=G|price=€35}}',
        '===Mid-range===',
        '* {{sleep|name=H|price=From €900/month}}',
        '* {{sleep|name=I}}',
      ].join('\n'),
    );
    const { costs, pricedListings } = deriveCosts(doc);
    expect(pricedListings).toEqual({ sleep: 5, eat: 3 });
    expect(costs.levels.budget.lodging_night).toEqual({
      median: 30,
      min: 25,
      max: 35,
      currency: '€',
      sample_size: 3,
      excluded_other_currency: 0,
    });
    expect(costs.levels.budget.meal?.median).toBe(10);
    expect(costs.levels.budget.notes).toContain(
      '1 Sleep listing price(s) under Budget had no amount with a currency.',
    );
    expect(costs.levels.mid.lodging_night).toBeNull();
    expect(costs.levels.mid.notes).toContain(
      '1 Sleep listing price(s) under Mid-range quoted per week or month were left out.',
    );
    expect(costs.levels.comfort.meal?.median).toBe(90);
    expect(costs.levels.comfort.lodging_night).toBeNull();
    expect(costs.overall.lodging_night?.sample_size).toBe(3);
  });

  it('returns null values with notes when the article has no priced listings', () => {
    const { costs, pricedListings } = deriveCosts(
      convertArticle('Region', '==Sleep==\nPlenty of hotels in every town.'),
    );
    expect(pricedListings).toEqual({ sleep: 0, eat: 0 });
    expect(costs.overall).toEqual({
      lodging_night: null,
      meal: null,
      notes: [
        'No Sleep listing in the documents has a parseable price: value unknown.',
        'No Eat listing in the documents has a parseable price: value unknown.',
      ],
    });
    expect(costs.levels.budget.lodging_night).toBeNull();
    expect(costs.levels.budget.notes[0]).toMatch(/No document has priced listings under Budget/);
  });
});

describe('deriveCosts over several documents', () => {
  it('pools the priced listings of the region guide and its place articles', () => {
    const region = convertArticle('Region', '==Sleep==\n* {{sleep|name=A|price=€40}}');
    const town = convertArticle(
      'Town',
      '==Sleep==\n===Budget===\n* {{sleep|name=B|price=€20}}\n* {{sleep|name=C|price=€30}}',
    );
    const { costs, pricedListings } = deriveCosts([region, town]);
    expect(pricedListings).toEqual({ sleep: 3, eat: 0 });
    expect(costs.overall.lodging_night?.median).toBe(30);
    expect(costs.levels.budget.lodging_night?.median).toBe(25);
    expect(costs.levels.mid.lodging_night).toBeNull();
  });
});
