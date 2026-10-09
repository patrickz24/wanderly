import { describe, expect, it } from 'vitest';
import {
  type Block,
  type GuideDocument,
  collectListings,
  convertArticle,
  countWords,
  removeFileLinks,
  renderGuideMarkdown,
  renderListing,
  wikitextToPlainText,
} from './wikitext.js';

const items = (doc: GuideDocument, title: string): Extract<Block, { type: 'item' }>[] =>
  (doc.sections.find((section) => section.title === title)?.blocks ?? []).filter(
    (block): block is Extract<Block, { type: 'item' }> => block.type === 'item',
  );

describe('listing templates', () => {
  const wikitext = [
    'Intro.',
    '==See==',
    '* {{see',
    '| name=Museo [[Archeologico]] | alt=Archaeological Museum | url=http://example.org',
    '| lat=38.1 | long=13.3 | hours=Tu-Su 09:00-19:00 | price={{EUR|8}}, reduced €4',
    "| content=Greek ''metopes'' from Selinunte, {{km|2}} from the port.<ref>source</ref>",
    '}}',
    '* {{see|name=Teatro Massimo}}',
  ].join('\n');

  it('renders a listing as a bullet "**Name** (alt) — description (price: …; hours: …)"', () => {
    const doc = convertArticle('Palermo', wikitext);
    const markdown = renderGuideMarkdown(doc);
    expect(markdown).toContain(
      '- **Museo Archeologico** (Archaeological Museum) — Greek metopes from Selinunte, 2 km from ' +
        'the port. (price: €8, reduced €4; hours: Tu-Su 09:00-19:00)',
    );
    expect(markdown).toContain('- **Teatro Massimo**\n');
    expect(markdown).not.toMatch(/\{\{|\}\}|\[\[|''|<ref|QQWVTOKEN/);
  });

  it('keeps the listing fields for fact extraction', () => {
    const [first] = collectListings(convertArticle('Palermo', wikitext));
    expect(first?.path).toEqual(['See']);
    expect(first?.listing).toEqual({
      type: 'see',
      name: 'Museo Archeologico',
      alt: 'Archaeological Museum',
      description: 'Greek metopes from Selinunte, 2 km from the port.',
      price: '€8, reduced €4',
      hours: 'Tu-Su 09:00-19:00',
    });
  });

  it('uses the type of a generic {{listing}} and counts listings written inside paragraphs', () => {
    const doc = convertArticle(
      'X',
      '==Sleep==\nThere is {{listing|type=sleep|name=Hostel|price=€20}} near the port.',
    );
    expect(collectListings(doc).map(({ listing }) => listing.type)).toEqual(['sleep']);
    expect(renderGuideMarkdown(doc)).toContain('There is **Hostel** (price: €20) near the port.');
  });

  it('formats a listing without a name or description gracefully', () => {
    expect(
      renderListing({
        type: 'eat',
        name: '',
        alt: null,
        description: 'Fish stalls.',
        price: null,
        hours: null,
      }),
    ).toBe('Fish stalls.');
  });
});

describe('document structure', () => {
  const wikitext = [
    '{{pagebanner|Banner.jpg}}',
    "'''Sicily''' is an island.[[File:Etna.jpg|thumb|The [[Mount Etna|volcano]]]]",
    '<!-- editor note -->',
    '==Regions==',
    '{{Regionlist',
    '| region1name=[[Palermo (province)|Palermo]] | region1color=#fff',
    '| region1items=[[Palermo]], [[Cefalù]] | region1description=The northwest.',
    '}}',
    '==Cities==',
    '* {{marker|type=city|name=[[Catania]]|lat=37.5|long=15.08}} – lively city at the foot of Etna',
    '==Understand==',
    '===History===',
    '====Empty subsection====',
    '==Get in==',
    '{{IsPartOf|Italy}}',
    '==Talk==',
    '{{infobox|Dialect|Sicilian is spoken by many.}}',
    '{{cautionbox|Roads are steep.}}',
    '==Do==',
    '{{mapframe|37.5|14}}',
    '{| class="wikitable"',
    '| Ferry || 2 h',
    '|-',
    '| Plane || 1 h',
    '|}',
    '[[Category:Regions]]',
  ].join('\n');
  const doc = convertArticle('Sicily', wikitext);

  it('puts the lead under "Overview" and drops empty sections and subsections', () => {
    expect(doc.sections.map((section) => section.path.join(' > '))).toEqual([
      'Overview',
      'Regions',
      'Cities',
      'Talk',
      'Do',
    ]);
  });

  it('renders region lists, markers, boxes and tables', () => {
    const markdown = renderGuideMarkdown(doc);
    expect(markdown).toContain('- **Palermo** — The northwest. (main places: Palermo, Cefalù)');
    expect(markdown).toContain('- **Catania** – lively city at the foot of Etna');
    expect(markdown).toContain('> **Dialect:** Sicilian is spoken by many.');
    expect(markdown).toContain('> **Caution:** Roads are steep.');
    expect(markdown).toContain('- Ferry — 2 h\n- Plane — 1 h');
  });

  it('removes images, comments, banners, maps and categories', () => {
    const markdown = renderGuideMarkdown(doc);
    expect(markdown.startsWith('# Sicily\n\n## Overview\n\nSicily is an island.\n')).toBe(true);
    expect(markdown).not.toMatch(/volcano|editor note|Banner|Category|mapframe/);
  });

  it('records the {{IsPartOf}} breadcrumb', () => {
    expect(doc.isPartOf).toEqual(['Italy']);
  });

  it('identifies marker items as entries with their description', () => {
    expect(items(doc, 'Cities')[0]?.entry).toEqual({
      source: 'marker',
      name: 'Catania',
      description: 'lively city at the foot of Etna',
    });
  });
});

describe('named list items', () => {
  const doc = convertArticle(
    'X',
    [
      '==See==',
      "* '''Valley of the Temples''' – Greek temples near [[Agrigento]].",
      "* '''Palma old town''' is centred on its cathedral.",
      "* The '''[[Gullfoss]]''' waterfall is spectacular.",
      "* '''Hiking:''' the GR221 trail.",
      "* '''Samaria Gorge''' (Greek: Φαράγγι Σαμαριάς) — a long gorge.",
      '* Visit the markets.',
    ].join('\n'),
  );

  it('extracts the leading bold or linked name and a description', () => {
    expect(items(doc, 'See').map((item) => item.entry)).toEqual([
      {
        source: 'named',
        name: 'Valley of the Temples',
        description: 'Greek temples near Agrigento.',
      },
      {
        source: 'named',
        name: 'Palma old town',
        description: 'Palma old town is centred on its cathedral.',
      },
      { source: 'named', name: 'Gullfoss', description: 'The Gullfoss waterfall is spectacular.' },
      { source: 'named', name: 'Hiking', description: 'Hiking: the GR221 trail.' },
      { source: 'named', name: 'Samaria Gorge', description: 'a long gorge.' },
      null,
    ]);
  });
});

describe('inline templates', () => {
  it('renders Wikivoyage unit, currency and airport templates', () => {
    expect(
      wikitextToPlainText(
        'Fly to {{IATA|FAO}}, {{km|20}} away, {{m|2351}} high, {{c|15-25}}, entry {{EUR|10}}, {{km2|5}}.',
      ),
    ).toBe('Fly to FAO, 20 km away, 2351 m high, 15-25 °C, entry €10, 5 km².');
  });

  it('delegates generic templates to wtf_wikipedia and drops boilerplate boxes', () => {
    expect(wikitextToPlainText('{{lang|it|Sicilia}} uses the euro.{{Euro}}{{Schengen}}')).toBe(
      'Sicilia uses the euro.',
    );
    expect(wikitextToPlainText('a {{UNESCO}}.')).toBe('a UNESCO World Heritage Site.');
  });

  it('reports unknown templates that render to nothing', () => {
    const doc = convertArticle('X', '==See==\nText {{someunknowntemplate|a}} here.');
    expect(doc.warnings).toEqual(['dropped unknown template {{someunknowntemplate}}']);
  });
});

describe('helpers', () => {
  it('removes nested file links but keeps ordinary links', () => {
    expect(removeFileLinks('a [[File:x.jpg|thumb|see [[Etna]]]] b [[Etna]]')).toBe('a  b [[Etna]]');
  });

  it('counts words, ignoring Markdown punctuation', () => {
    expect(countWords('- **Mount Etna** — 3,357 m high')).toBe(5);
  });
});
