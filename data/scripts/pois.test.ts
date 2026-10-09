import { describe, expect, it } from 'vitest';
import { buildPois, collectPoiCandidates, slugify } from './pois.js';
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
      '==Eat==',
      "* '''Arancini''' – rice balls",
    ].join('\n'),
  );

  it('collects see/do listings, markers of Other destinations and named items only', () => {
    expect(
      collectPoiCandidates(doc).map((candidate) => [candidate.source, candidate.name]),
    ).toEqual([
      ['marker', 'Mount Etna'],
      ['listing', 'Museo Salinas'],
      ['named', 'Mount Etna'],
      ['named', 'Hiking'],
    ]);
  });

  it('builds schema POIs with stable ids, kinds and source_ref, dropping duplicates', () => {
    const { pois, sources, duplicatesDropped } = buildPois('sicily', collectPoiCandidates(doc));
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
        source_ref: 'Other destinations',
      },
      {
        id: 'sicily-museo-salinas',
        name: 'Museo Salinas',
        kinds: ['historic_site', 'museum'],
        description: 'Archaeology collection.',
        crowd_level: null,
        best_months: [],
        source_ref: 'See > Museums',
      },
      {
        id: 'sicily-hiking',
        name: 'Hiking',
        kinds: ['hiking'],
        description: 'Hiking: trails on the Madonie.',
        crowd_level: null,
        best_months: [],
        source_ref: 'Do',
      },
    ]);
  });

  it('describes a marker used as the subject of a sentence with the whole sentence, as plain text', () => {
    const mallorca = convertArticle(
      'Mallorca',
      '==Other destinations==\n* {{marker|type=other|name=Santuari de Lluc}} is a monastery.',
    );
    const { pois } = buildPois('mallorca', collectPoiCandidates(mallorca));
    expect(pois[0]?.description).toBe('Santuari de Lluc is a monastery.');
    expect(pois[0]?.kinds).toEqual(['religious_site']);
  });

  it('falls back to a positional id when the name has no ASCII letters', () => {
    const { pois } = buildPois('crete', [
      { name: 'Κνωσός', description: null, sectionPath: ['See'], source: 'named' },
    ]);
    expect(pois[0]?.id).toBe('crete-poi-1');
  });
});
