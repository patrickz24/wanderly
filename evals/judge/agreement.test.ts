import { describe, expect, it } from 'vitest';
import { cohensKappa } from './agreement.js';

describe('cohensKappa', () => {
  it('is 1 for perfect agreement over varied labels', () => {
    expect(
      cohensKappa([
        [1, 1],
        [0, 0],
        [1, 1],
        [0, 0],
      ] as const),
    ).toEqual({
      n: 4,
      agreement: 1,
      kappa: 1,
    });
  });

  it('is 0 when agreement equals chance', () => {
    // Each rater says "yes" half the time, independently: chance agreement 0.5.
    const result = cohensKappa([
      ['yes', 'yes'],
      ['yes', 'no'],
      ['no', 'yes'],
      ['no', 'no'],
    ] as const);
    expect(result.agreement).toBe(0.5);
    expect(result.kappa).toBeCloseTo(0);
  });

  it('matches a textbook example', () => {
    // 50 items: 20 yes/yes, 5 yes/no, 10 no/yes, 15 no/no -> po = 0.7, pe = 0.5, kappa = 0.4.
    const pairs = [
      ...Array.from({ length: 20 }, () => ['y', 'y'] as const),
      ...Array.from({ length: 5 }, () => ['y', 'n'] as const),
      ...Array.from({ length: 10 }, () => ['n', 'y'] as const),
      ...Array.from({ length: 15 }, () => ['n', 'n'] as const),
    ];
    const result = cohensKappa(pairs);
    expect(result.agreement).toBeCloseTo(0.7);
    expect(result.kappa).toBeCloseTo(0.4);
  });

  it('is undefined when both raters use a single identical label', () => {
    expect(
      cohensKappa([
        [2, 2],
        [2, 2],
      ] as const).kappa,
    ).toBeNull();
  });

  it('handles no items', () => {
    expect(cohensKappa([])).toEqual({ n: 0, agreement: 0, kappa: null });
  });
});
