import { EMPTY_TRIP_BRIEF } from '@wanderly/contracts';
import { describe, expect, it } from 'vitest';
import { listedOptions, quickRepliesFor } from './quickReplies';

const single = { questionCount: 1, brief: EMPTY_TRIP_BRIEF };
const several = { questionCount: 2, brief: EMPTY_TRIP_BRIEF };

describe('listedOptions', () => {
  it.each<[string, string[]]>([
    [
      'What budget level do you have in mind (budget, mid or comfort)?',
      ['Budget', 'Mid', 'Comfort'],
    ],
    ['Which pace suits you: relaxed, balanced, or intense?', ['Relaxed', 'Balanced', 'Intense']],
    ['Do you prefer (beach / mountains)?', ['Beach', 'Mountains']],
    ['Who is travelling: solo or a couple?', ['Solo', 'A couple']],
  ])('extracts the options of %j', (question, options) => {
    expect(listedOptions(question)).toEqual(options);
  });

  it.each([
    'Which month are you travelling in?',
    'What do you enjoy (e.g. hiking, food, museums)?',
    'Anything else (such as hiking or food)?',
    'Which places: a, b, c, d, e, f?',
    'How long: a very long option that is clearly not a short choice, or another?',
    'Pick one (only)?',
    'Which one (a, a)?',
  ])('finds no closed choice in %j', (question) => {
    expect(listedOptions(question)).toEqual([]);
  });
});

describe('quickRepliesFor', () => {
  it('prefers the options the question lists', () => {
    expect(quickRepliesFor('Which pace: relaxed or active?', single)).toEqual([
      'Relaxed',
      'Active',
    ]);
  });

  it('offers the budget levels when the brief has none', () => {
    expect(quickRepliesFor('What budget do you have in mind?', several)).toEqual([
      'Budget',
      'Mid-range',
      'Comfort',
    ]);
  });

  it('does not offer budget levels once the brief has one', () => {
    const brief = { ...EMPTY_TRIP_BRIEF, budgetLevel: 'mid' as const };
    expect(quickRepliesFor('Is the budget flexible?', { questionCount: 2, brief })).toEqual([]);
  });

  it('offers yes/no for a single closed question', () => {
    expect(quickRepliesFor('Are you travelling with children?', single)).toEqual(['Yes', 'No']);
  });

  it('does not offer yes/no when several questions are asked', () => {
    expect(quickRepliesFor('Are you travelling with children?', several)).toEqual([]);
  });

  it('does not offer yes/no for an either-or question', () => {
    expect(quickRepliesFor('Do you prefer beaches or mountains?', single)).toEqual([]);
  });

  it('offers nothing for an open question', () => {
    expect(quickRepliesFor('How many days will you have?', single)).toEqual([]);
  });
});
