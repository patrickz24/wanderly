import { describe, expect, it } from 'vitest';
import { chunkSource, poiSource, weatherSource } from '../test/factories';
import { isWikivoyageUrl, licenceFor, numberSources, safeExternalUrl, sourceKey } from './sources';

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

describe('licenceFor', () => {
  it('uses the licence the API declares, linked when it is a known one', () => {
    expect(licenceFor({ ...chunkSource, license: 'CC BY-SA 4.0' })).toEqual({
      name: 'CC BY-SA 4.0',
      url: 'https://creativecommons.org/licenses/by-sa/4.0/deed.en',
    });
    expect(licenceFor({ ...chunkSource, license: 'Some other licence' })).toEqual({
      name: 'Some other licence',
      url: null,
    });
  });

  it('falls back to the corpus licence when the API sends none', () => {
    expect(licenceFor({ ...chunkSource, license: null })?.name).toBe('CC BY-SA 4.0');
    expect(licenceFor(weatherSource)?.name).toBe('CC BY 4.0');
    expect(licenceFor({ ...chunkSource, url: 'https://example.org/' })).toBeNull();
  });
});
