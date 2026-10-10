import { describe, expect, it } from 'vitest';
import {
  type Candidate,
  articleType,
  candidateTitles,
  measurePlace,
  normaliseTitle,
  placeId,
  selectPlaces,
  setPlacesBlock,
} from './places.js';
import { convertArticle } from './wikitext.js';

describe('candidateTitles', () => {
  const wikitext = [
    "'''Region''' is nice. See [[Elsewhere]].",
    '==Regions==',
    '{{Regionlist',
    '| region1name=[[North (province)|North]]',
    '| region1items=[[Alpha]], [[Beta town|Beta]]',
    '| region1description=Hills.',
    '* {{marker|type=city|name=[[Gamma]]}} — nested in the region list',
    '}}',
    '==Cities==',
    '* {{marker|type=city|name=[[Alpha]]|lat=1|long=2}} — duplicate',
    '* [[delta_(island)|Delta]] — a link-led item, and [[Epsilon]] later on the line',
    '* [[File:x.jpg]] [[w:Zeta|Zeta]] — namespaced links are ignored',
    '==Understand==',
    '* {{marker|type=city|name=[[After]]}} — not a destination-listing section',
  ].join('\n');

  it('collects markers, region list names and items, and the first link of list items', () => {
    expect(candidateTitles(wikitext)).toEqual([
      'North (province)',
      'Alpha',
      'Beta town',
      'Gamma',
      'Delta (island)',
    ]);
  });

  it('normalises titles like MediaWiki (first letter upper-case, underscores to spaces)', () => {
    expect(normaliseTitle('syracuse_(Italy)')).toBe('Syracuse (Italy)');
    expect(placeId('Syracuse (Italy)')).toBe('syracuse-italy');
  });
});

describe('articleType', () => {
  it('reads the status template', () => {
    expect(articleType('{{pagebanner|x}}\n{{usablecity}}')).toBe('city');
    expect(articleType('{{outlineregion}}')).toBe('region');
    expect(articleType('{{guidepark}}')).toBe('park');
    expect(articleType('{{usableruralarea}}')).toBe('ruralarea');
    expect(articleType('no status')).toBeNull();
  });
});

describe('measurePlace', () => {
  it('counts See/Do listings and priced Sleep/Eat listings, inside price levels or not', () => {
    const doc = convertArticle(
      'Town',
      [
        '==See==',
        '* {{see|name=Castle}}',
        '==Do==',
        '* {{do|name=Boat trip|price=€20}}',
        '==Eat==',
        '* {{eat|name=Snack|price=€€}}',
        '* {{eat|name=Trattoria|price=Mains €12-18}}',
        '==Sleep==',
        '===Budget===',
        '* {{sleep|name=Hostel|price=Dorms €25}}',
        '* {{sleep|name=Flat|price=€900/month}}',
      ].join('\n'),
    );
    expect(measurePlace(doc)).toEqual({
      seeDoListings: 2,
      pricedSleepEat: 2,
      pricedInLevels: 1,
      listings: 6,
    });
  });
});

describe('selectPlaces', () => {
  const candidate = (
    title: string,
    type: string | null,
    pricedInLevels: number,
    pricedSleepEat: number,
    seeDoListings: number,
  ): Candidate => ({
    title,
    type,
    metrics: { pricedInLevels, pricedSleepEat, seeDoListings, listings: 0 },
  });

  it('keeps eligible places ranked by price levels, prices, sights, then title', () => {
    const rows = selectPlaces(
      [
        candidate('Province', 'region', 9, 9, 9),
        candidate('Quiet', 'city', 0, 2, 4),
        candidate('Sights', 'city', 0, 0, 30),
        candidate('Priced', 'city', 0, 12, 1),
        candidate('Levels', 'city', 3, 3, 0),
        candidate('Bravo', 'park', 0, 4, 5),
        candidate('Alpha', 'ruralarea', 0, 4, 5),
      ],
      3,
    );
    expect(rows.map((row) => [row.candidate.title, row.verdict])).toEqual([
      ['Province', 'wrong type'],
      ['Levels', 'selected'],
      ['Priced', 'selected'],
      ['Alpha', 'selected'],
      ['Bravo', 'eligible'],
      ['Quiet', 'too few listings'],
      ['Sights', 'eligible'],
    ]);
  });
});

describe('setPlacesBlock', () => {
  const yaml = [
    '# comment kept',
    'destinations:',
    '  - id: sicily',
    '    name: Sicily',
    '    climate_point:',
    '      lat: 1',
    '    substitution:',
    '      reason: >-',
    '        folded text',
    '        kept as is',
    '',
    '  - id: crete',
    '    name: Crete',
    '    places:',
    '      - id: old',
    '        title: Old',
    '    note: kept',
    '',
  ].join('\n');

  it('appends a places block at the end of an entry without touching other lines', () => {
    const out = setPlacesBlock(yaml, 'sicily', [
      { id: 'syracuse-italy', title: 'Syracuse (Italy)' },
    ]);
    expect(out).toBe(
      yaml.replace(
        '        kept as is\n',
        '        kept as is\n    places:\n      - id: syracuse-italy\n        title: Syracuse (Italy)\n',
      ),
    );
  });

  it('replaces an existing block and writes an empty list when nothing is selected', () => {
    const out = setPlacesBlock(yaml, 'crete', []);
    expect(out).toContain('    name: Crete\n    note: kept\n    places: []\n');
    expect(out).not.toContain('id: old');
    expect(() => setPlacesBlock(yaml, 'atlantis', [])).toThrow(/no entry/);
  });
});
