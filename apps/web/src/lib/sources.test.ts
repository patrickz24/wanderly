import { describe, expect, it } from 'vitest';
import { chunkSource, poiSource, weatherSource } from '../test/factories';
import { isWikivoyageUrl, numberSources, safeExternalUrl, sourceKey } from './sources';

describe('numberSources', () => {
  it('numbers sources from 1 in their listed order, once each', () => {
    const numbers = numberSources([chunkSource, poiSource, chunkSource, weatherSource]);

    expect([...numbers.entries()]).toEqual([
      [sourceKey(chunkSource), 1],
      [sourceKey(poiSource), 2],
      [sourceKey(weatherSource), 3],
    ]);
  });

  it('tells sources of different kinds apart even with the same id', () => {
    const numbers = numberSources([
      { ...weatherSource, id: 'toolu_1' },
      { ...weatherSource, kind: 'budget', id: 'toolu_1' },
    ]);
    expect(numbers.size).toBe(2);
  });
});

describe('safeExternalUrl', () => {
  it.each([
    [
      'https://en.wikivoyage.org/w/index.php?oldid=1',
      'https://en.wikivoyage.org/w/index.php?oldid=1',
    ],
    ['http://example.org/', 'http://example.org/'],
    ['javascript:alert(1)', null],
    ['data:text/html,hi', null],
    ['not a url', null],
    [null, null],
  ])('accepts only http(s): %j', (url, expected) => {
    expect(safeExternalUrl(url)).toBe(expected);
  });
});

describe('isWikivoyageUrl', () => {
  it.each([
    ['https://en.wikivoyage.org/wiki/Sicily', true],
    ['https://wikivoyage.org/', true],
    ['https://wikivoyage.org.evil.test/', false],
    ['https://example.org/wikivoyage.org', false],
    [null, false],
  ])('%j → %s', (url, expected) => {
    expect(isWikivoyageUrl(url)).toBe(expected);
  });
});
