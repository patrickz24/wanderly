import { describe, expect, it } from 'vitest';
import { toWebSearchQuery } from './full-text-query.js';

describe('toWebSearchQuery', () => {
  it('keeps the text as is in "all" mode (websearch_to_tsquery ANDs the words)', () => {
    expect(toWebSearchQuery('"Samaria Gorge" -crowds', 'all')).toBe('"Samaria Gorge" -crowds');
  });

  it('joins the words with the websearch "or" operator in "any" mode', () => {
    expect(toWebSearchQuery('Which beaches suit families?', 'any')).toBe(
      'Which or beaches or suit or families',
    );
  });

  it('drops quotes, negations and a literal "or", and keeps apostrophes and accents', () => {
    expect(toWebSearchQuery('"Ca\' d\'Oro" -crowded or Ηράκλειον’s café', 'any')).toBe(
      "Ca or d'Oro or crowded or Ηράκλειον’s or café",
    );
  });

  it('returns an empty query when there is no word', () => {
    expect(toWebSearchQuery(' -- !? ', 'any')).toBe('');
  });
});
