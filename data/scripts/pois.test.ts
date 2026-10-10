import { describe, expect, it } from 'vitest';
import { buildPois, collectPoiCandidates, isGenericName, slugify } from './pois.js';
import { convertArticle } from './wikitext.js';

describe('slugify', () => {
  it('produces ASCII kebab-case ids', () => {
    expect(slugify('Þingvellir National Park')).toBe('thingvellir-national-park');
    expect(slugify("Witches' benches")).toBe('witches-benches');
    expect(slugify('Ðakovo – Église Saint-Étienne!')).toBe('dakovo-eglise-saint-etienne');
    expect(slugify('Lofotøyene')).toBe('lofotoyene');
    expect(slugify('Κρήτη')).toBe('');
  });
});

describe('isGenericName', () => {
  it.each([
    'Churches',
    'Beaches',
    'Golf',
    'Monasteries and convents',
    'Archeological sites',
    'Whale and dolphin watching',
    'Moto 4 Rides',
    'Rent a scooter',
    'Off-road mountain bike circuits',
    'Glacier hiking',
    'Sailing and yachting',
    'Swimming pool',
  ])('treats %j as an activity or category heading', (name) => {
    expect(isGenericName(name)).toBe(true);
  });

  it.each([
    'Palma old town',
    'Volcano Climbing at Pico island',
    'GR 20',
    'Valldemossa',
    'Levadas',
    'Lake Negratin',
    'Town Square of Hvar',
  ])('keeps %j, which names a specific place', (name) => {
    expect(isGenericName(name)).toBe(false);
  });
});

describe('POI extraction', () => {
  const doc = convertArticle(
    'Sicily',
    [
      '==Cities==',
      '* {{marker|type=city|name=[[Palermo]]}} – capital',
      '==Other destinations==',
      '* {{marker|type=vicinity|name=[[Mount Etna]]}} – Europe’s highest active volcano',
      '==See==',
      '===Museums===',
      '* {{see|name=Museo Salinas|content=Archaeology collection.}}',
      '* {{eat|name=Not a POI|price=€10}}',
      "* '''Mount Etna''' – duplicate of the marker above",
      '==Do==',
      "* '''Hiking:''' trails on the Madonie.",
      "* '''Madonie trails:''' marked paths above Cefalù.",
      '==Eat==',
      "* '''Arancini''' – rice balls",
    ].join('\n'),
  );

  it('collects see/do listings, markers and named items, pruning generic headings', () => {
    const { candidates, genericPruned } = collectPoiCandidates(doc);
    expect(candidates.map((candidate) => [candidate.source, candidate.name])).toEqual([
      ['marker', 'Mount Etna'],
      ['listing', 'Museo Salinas'],
      ['named', 'Mount Etna'],
      ['named', 'Madonie trails'],
    ]);
    expect(genericPruned).toBe(1);
  });

  it('builds schema POIs with stable ids, kinds and source_ref, dropping duplicates', () => {
    const { pois, sources, duplicatesDropped } = buildPois(
      'sicily',
      collectPoiCandidates(doc).candidates,
    );
    expect(duplicatesDropped).toBe(1);
    expect(sources).toEqual({ listing: 1, marker: 1, named: 1 });
    expect(pois).toEqual([
      {
        id: 'sicily-mount-etna',
        name: 'Mount Etna',
        kinds: ['nature'],
        description: 'Europe’s highest active volcano',
        crowd_level: null,
        best_months: [],
        source_ref: 'Sicily > Other destinations',
        crowd_evidence: [],
        months_evidence: [],
      },
      {
        id: 'sicily-museo-salinas',
        name: 'Museo Salinas',
        kinds: ['historic_site', 'museum'],
        description: 'Archaeology collection.',
        crowd_level: null,
        best_months: [],
        source_ref: 'Sicily > See > Museums',
        crowd_evidence: [],
        months_evidence: [],
      },
      {
        id: 'sicily-madonie-trails',
        name: 'Madonie trails',
        kinds: ['hiking'],
        description: 'Madonie trails: marked paths above Cefalù.',
        crowd_level: null,
        best_months: [],
        source_ref: 'Sicily > Do',
        crowd_evidence: [],
        months_evidence: [],
      },
    ]);
  });

  it('prefixes ids with the place id and source_ref with the place title for place articles', () => {
    const palermo = convertArticle(
      'Palermo',
      '==See==\n===Museums===\n* {{see|name=Museo Salinas|content=Archaeology collection.}}',
    );
    const region = collectPoiCandidates(doc).candidates;
    const place = collectPoiCandidates(palermo, {
      title: 'Palermo',
      placeId: 'palermo',
    }).candidates;
    const { pois, duplicatesDropped } = buildPois('sicily', [...region, ...place]);
    expect(duplicatesDropped).toBe(1);
    expect(pois.at(-1)).toMatchObject({
      id: 'sicily-palermo-museo-salinas',
      source_ref: 'Palermo > See > Museums',
    });
  });

  it('describes a marker used as the subject of a sentence with the whole sentence, as plain text', () => {
    const mallorca = convertArticle(
      'Mallorca',
      '==Other destinations==\n* {{marker|type=other|name=Santuari de Lluc}} is a monastery.',
    );
    const { pois } = buildPois('mallorca', collectPoiCandidates(mallorca).candidates);
    expect(pois[0]?.description).toBe('Santuari de Lluc is a monastery.');
    expect(pois[0]?.kinds).toEqual(['religious_site']);
  });

  it('falls back to a positional id when the name has no ASCII letters', () => {
    const { pois } = buildPois('crete', [
      {
        name: 'Κνωσός',
        description: null,
        sectionPath: ['See'],
        source: 'named',
        document: { title: 'Crete', placeId: null },
      },
    ]);
    expect(pois[0]?.id).toBe('crete-poi-1');
  });
});

describe('POI curation', () => {
  it('fills crowd level and best months from the POI text and its named mentions, with evidence', () => {
    const doc = convertArticle(
      'Town',
      [
        '==See==',
        'The Old Harbour gets very crowded when cruise ships call. Other text.',
        '* {{see|name=Old Harbour|content=Fishing boats. Best visited in spring.}}',
        '* {{see|name=Hill Chapel|content=A peaceful spot. Closed in winter.}}',
        '* {{see|name=Museum|content=Paintings.}}',
      ].join('\n'),
    );
    const { pois } = buildPois('x', collectPoiCandidates(doc).candidates);
    expect(pois.map((poi) => [poi.name, poi.crowd_level, poi.best_months])).toEqual([
      ['Old Harbour', 4, [3, 4, 5]],
      ['Hill Chapel', 2, [3, 4, 5, 6, 7, 8, 9, 10, 11]],
      ['Museum', null, []],
    ]);
    expect(pois[0]?.crowd_evidence).toEqual([
      'The Old Harbour gets very crowded when cruise ships call.',
    ]);
    expect(pois[0]?.months_evidence).toEqual(['Best visited in spring.']);
    expect(pois[2]?.crowd_evidence).toEqual([]);
  });
});
