import { describe, expect, it } from 'vitest';
import {
  averageScores,
  bootstrapMeanInterval,
  coversSection,
  firstRelevantRank,
  hitAtK,
  isRelevant,
  matchTargets,
  mean,
  pairedDifferenceInterval,
  recallAtK,
  reciprocalRankAtK,
  scoreQuery,
  seededRandom,
  type RetrievedSections,
  type SectionTarget,
} from './retrieval-metrics.js';

const hiking: SectionTarget = {
  destinationId: 'sicily',
  document: 'guide.md',
  headingPath: 'Do > Hiking',
};
const stay: SectionTarget = {
  destinationId: 'sicily',
  document: 'places/palermo.md',
  headingPath: 'Stay safe',
};

const chunk = (documentPath: string, ...sections: string[]): RetrievedSections => ({
  destinationId: documentPath.split('/')[0] ?? '',
  documentPath,
  sections,
});

describe('relevance', () => {
  it('matches the target section and its subsections, not its parent or siblings', () => {
    expect(coversSection(['Do > Hiking'], 'Do > Hiking')).toBe(true);
    expect(coversSection(['Do > Hiking > Etna'], 'Do > Hiking')).toBe(true);
    expect(coversSection(['Do'], 'Do > Hiking')).toBe(false);
    expect(coversSection(['Do > Hiking trails'], 'Do > Hiking')).toBe(false);
    expect(coversSection(['Do > Beaches', 'Do > Hiking'], 'Do > Hiking')).toBe(true);
    expect(coversSection(['Do > Hiking'], 'Do')).toBe(true);
  });

  it('requires the same destination and document', () => {
    expect(isRelevant(chunk('sicily/guide.md', 'Do > Hiking'), hiking)).toBe(true);
    expect(isRelevant(chunk('sicily/places/palermo.md', 'Do > Hiking'), hiking)).toBe(false);
    expect(isRelevant(chunk('crete/guide.md', 'Do > Hiking'), hiking)).toBe(false);
  });

  it('lists the targets each result is relevant to', () => {
    const results = [
      chunk('sicily/guide.md', 'Eat'),
      chunk('sicily/places/palermo.md', 'Stay safe'),
      chunk('sicily/guide.md', 'Do > Hiking', 'Do > Skiing'),
    ];

    expect(matchTargets(results, [hiking, stay])).toEqual([[], [1], [0]]);
  });
});

describe('rank metrics', () => {
  const matches = [[], [1], [], [0], [1]];

  it('computes recall@k over distinct targets', () => {
    expect(recallAtK(matches, 2, 1)).toBe(0);
    expect(recallAtK(matches, 2, 2)).toBe(0.5);
    expect(recallAtK(matches, 2, 5)).toBe(1);
    expect(recallAtK([[0], [0]], 2, 5)).toBe(0.5);
  });

  it('computes the reciprocal rank and hit within k', () => {
    expect(reciprocalRankAtK(matches, 10)).toBe(0.5);
    expect(reciprocalRankAtK(matches, 1)).toBe(0);
    expect(hitAtK(matches, 1)).toBe(0);
    expect(hitAtK(matches, 2)).toBe(1);
    expect(firstRelevantRank(matches)).toBe(2);
    expect(firstRelevantRank([[], []])).toBeNull();
  });

  it('rejects invalid k and queries without targets', () => {
    expect(() => recallAtK(matches, 0, 5)).toThrow(RangeError);
    expect(() => reciprocalRankAtK(matches, 0)).toThrow(RangeError);
    expect(() => hitAtK(matches, 1.5)).toThrow(RangeError);
  });

  it('scores a query on every metric', () => {
    const results = [
      chunk('sicily/guide.md', 'Eat'),
      ...Array.from({ length: 5 }, () => chunk('crete/guide.md', 'Do')),
      chunk('sicily/guide.md', 'Do > Hiking'),
    ];

    expect(scoreQuery(results, [hiking, stay])).toEqual({
      recallAt5: 0,
      recallAt10: 0.5,
      mrrAt10: 1 / 7,
      hitAt1: 0,
      hitAt5: 0,
    });
  });

  it('averages metrics over queries', () => {
    const perfect = { recallAt5: 1, recallAt10: 1, mrrAt10: 1, hitAt1: 1, hitAt5: 1 };
    const miss = { recallAt5: 0, recallAt10: 0, mrrAt10: 0, hitAt1: 0, hitAt5: 0 };

    expect(averageScores([perfect, miss, miss, perfect])).toEqual({
      recallAt5: 0.5,
      recallAt10: 0.5,
      mrrAt10: 0.5,
      hitAt1: 0.5,
      hitAt5: 0.5,
    });
    expect(() => mean([])).toThrow(RangeError);
  });
});

describe('bootstrap intervals', () => {
  it('is deterministic for a seed', () => {
    const first = seededRandom(7);
    const second = seededRandom(7);
    const draws = Array.from({ length: 5 }, () => first());

    expect(Array.from({ length: 5 }, () => second())).toEqual(draws);
    expect(draws.every((value) => value >= 0 && value < 1)).toBe(true);
  });

  it('brackets the mean and collapses for constant values', () => {
    const values = [0, 1, 0, 1, 1, 0, 1, 1, 0, 1];
    const interval = bootstrapMeanInterval(values, { resamples: 500 });

    expect(interval.low).toBeLessThan(mean(values));
    expect(interval.high).toBeGreaterThan(mean(values));
    expect(bootstrapMeanInterval([0.5, 0.5, 0.5])).toEqual({ low: 0.5, high: 0.5 });
    expect(bootstrapMeanInterval(values, { seed: 1 })).toEqual(
      bootstrapMeanInterval(values, { seed: 1 }),
    );
    expect(() => bootstrapMeanInterval([])).toThrow(RangeError);
  });

  it('gives the paired difference of two systems on the same queries', () => {
    const interval = pairedDifferenceInterval([1, 1, 1, 0], [0, 1, 0, 0]);

    expect(interval.mean).toBe(0.5);
    expect(interval.low).toBeGreaterThanOrEqual(0);
    expect(interval.high).toBeLessThanOrEqual(1);
    expect(() => pairedDifferenceInterval([1], [1, 0])).toThrow(RangeError);
  });
});
