import { describe, expect, it } from 'vitest';
import {
  chunk,
  DESTINATIONS,
  FakeKnowledge,
  FakeRetriever,
  poi,
} from '../../../test/support/agent-fakes.js';
import { createCatalog } from '../agent/catalog.js';
import { estimateBudgetTool } from './estimate-budget.js';
import { EvidenceRegistry } from './evidence.js';
import { getSeasonalWeatherTool, monthName } from './get-seasonal-weather.js';
import { excerpt, MAX_EXCERPT_CHARS, searchKnowledgeTool } from './search-knowledge.js';
import { searchPoisTool } from './search-pois.js';
import type { ToolContext } from './tool.js';

function context(overrides: Partial<ToolContext> = {}): ToolContext {
  return {
    callId: 'call-1',
    retriever: new FakeRetriever(),
    knowledge: new FakeKnowledge(),
    catalog: createCatalog(DESTINATIONS),
    evidence: new EvidenceRegistry(),
    ...overrides,
  };
}

describe('search_knowledge', () => {
  it('returns excerpts with refs to cite and records them as evidence', async () => {
    const retriever = new FakeRetriever();
    const ctx = context({ retriever });
    const result = await searchKnowledgeTool.run(
      { query: 'hiking', destinationId: 'sicily', limit: null },
      ctx,
    );

    expect(retriever.queries).toEqual([{ text: 'hiking', destinationId: 'sicily', limit: 5 }]);
    expect(result).toMatchObject({
      ok: true,
      output: {
        results: [
          {
            ref: { kind: 'chunk', id: 'chunk-sicily-hiking' },
            destinationId: 'sicily',
            section: 'Sicily > Do',
            text: 'The Madonie park has quiet hiking trails.',
          },
          { ref: { kind: 'chunk', id: 'chunk-sicily-etna' } },
        ],
      },
      summary: '2 guide excerpt(s) for "hiking"',
    });
    expect(ctx.evidence.has({ kind: 'chunk', id: 'chunk-sicily-etna' })).toBe(true);
  });

  it('adds each excerpt fused score and ranks to the trace output only', async () => {
    const ranked = {
      ...chunk('chunk-ranked', 'sicily', 'Quiet trails.'),
      score: 0.032,
      ranks: { vector: 1, fullText: null },
    };
    const result = await searchKnowledgeTool.run(
      { query: 'quiet trails', destinationId: null, limit: 1 },
      context({ retriever: new FakeRetriever([ranked]) }),
    );

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.output).toEqual({
      results: [
        {
          ref: { kind: 'chunk', id: 'chunk-ranked' },
          destinationId: 'sicily',
          section: 'Sicily > Do',
          text: 'Quiet trails.',
        },
      ],
    });
    expect(result.traceOutput).toEqual({
      results: [
        {
          ref: { kind: 'chunk', id: 'chunk-ranked' },
          destinationId: 'sicily',
          section: 'Sicily > Do',
          text: 'Quiet trails.',
          score: 0.032,
          ranks: { vector: 1, fullText: null },
        },
      ],
    });
  });

  it('gives the other tools no separate trace output', async () => {
    const result = await getSeasonalWeatherTool.run(
      { destinationId: 'sicily', month: 5 },
      context(),
    );
    expect(result.ok && 'traceOutput' in result).toBe(false);
  });

  it('cuts long excerpts and says when nothing was found', async () => {
    const long = chunk('c-long', 'sicily', 'x'.repeat(MAX_EXCERPT_CHARS + 50));
    const found = await searchKnowledgeTool.run(
      { query: 'long one', destinationId: null, limit: 1 },
      context({ retriever: new FakeRetriever([long]) }),
    );
    expect(found.ok && JSON.stringify(found.output).includes('…')).toBe(true);
    const empty = await searchKnowledgeTool.run(
      { query: 'nothing', destinationId: null, limit: 1 },
      context({ retriever: new FakeRetriever([]) }),
    );
    expect(empty).toMatchObject({
      ok: true,
      output: { results: [] },
      summary: 'No guide excerpt for "nothing"',
    });
  });

  it('rejects invalid arguments and unknown destinations', async () => {
    expect(await searchKnowledgeTool.run({ query: 'ok query' }, context())).toMatchObject({
      ok: false,
      error: expect.stringContaining('destinationId'),
    });
    expect(
      await searchKnowledgeTool.run(
        { query: 'beaches', destinationId: 'lisbon', limit: null },
        context(),
      ),
    ).toMatchObject({ ok: false, error: expect.stringContaining('unknown_destination') });
  });

  it('lets port failures propagate to the loop', async () => {
    const retriever = new FakeRetriever();
    retriever.search = async () => {
      throw new Error('db down');
    };
    await expect(
      searchKnowledgeTool.run(
        { query: 'hiking', destinationId: null, limit: null },
        context({ retriever }),
      ),
    ).rejects.toThrow('db down');
  });
});

describe('get_seasonal_weather', () => {
  it('returns the climate normals with the call id to cite', async () => {
    const ctx = context({ callId: 'w9' });
    const result = await getSeasonalWeatherTool.run({ destinationId: 'sicily', month: 5 }, ctx);
    expect(result).toEqual({
      ok: true,
      output: {
        found: true,
        weatherId: 'w9',
        ref: { kind: 'weather', id: 'w9' },
        destinationId: 'sicily',
        month: 5,
        monthName: 'May',
        avgHighC: 23,
        avgLowC: 16.1,
        rainDays: 8,
        precipitationMm: 67.4,
      },
      summary: 'May in sicily: 23°C / 16.1°C, 8 rainy days',
    });
    expect(ctx.evidence.weather('w9')?.fact.month).toBe(5);
  });

  it('says when there is no data, without creating evidence', async () => {
    const ctx = context();
    const result = await getSeasonalWeatherTool.run({ destinationId: 'crete', month: 1 }, ctx);
    expect(result).toMatchObject({ ok: true, output: { found: false } });
    expect(ctx.evidence.counts().weather).toBe(0);
  });

  it('names months', () => {
    expect(monthName(1)).toBe('January');
    expect(monthName(13)).toBe('month 13');
  });
});

describe('estimate_budget', () => {
  it('returns the estimate with its id and records it', async () => {
    const ctx = context({ callId: 'b7' });
    const result = await estimateBudgetTool.run(
      { destinationId: 'sicily', days: 2, travelers: 2, level: 'mid' },
      ctx,
    );
    expect(result).toMatchObject({
      ok: true,
      output: { estimateId: 'b7', ref: { kind: 'budget', id: 'b7' }, total: 300, perPerson: 150 },
      summary: 'mid budget for sicily: 300 EUR for 2 traveller(s), 2 day(s)',
    });
    expect(ctx.evidence.budget('b7')?.estimate.total).toBe(300);
  });

  it('records an estimate without figures too (citable, but not copyable)', async () => {
    const ctx = context();
    const result = await estimateBudgetTool.run(
      { destinationId: 'crete', days: 2, travelers: 2, level: 'mid' },
      ctx,
    );
    expect(result).toMatchObject({
      ok: true,
      summary: 'No complete mid budget for crete in the guide',
    });
    expect(ctx.evidence.budget('call-1')?.estimate.currency).toBeNull();
  });

  it('validates ranges the strict schema cannot express', async () => {
    const result = await estimateBudgetTool.run(
      { destinationId: 'sicily', days: 40, travelers: 2, level: 'mid' },
      context(),
    );
    expect(result).toMatchObject({ ok: false, error: expect.stringContaining('days') });
  });
});

describe('search_pois', () => {
  it('passes the filters and returns citable places of that destination only', async () => {
    const knowledge = new FakeKnowledge({
      pois: [poi('sicily-a', 'sicily', ['beach']), poi('crete-b', 'crete', ['beach'])],
    });
    knowledge.searchPois = async () => [
      poi('sicily-a', 'sicily', ['beach']),
      poi('crete-b', 'crete', ['beach']),
    ];
    const ctx = context({ knowledge });
    const result = await searchPoisTool.run(
      { destinationId: 'sicily', kinds: ['beach'], maxCrowdLevel: 3, month: 7, limit: null },
      ctx,
    );
    expect(result).toMatchObject({
      ok: true,
      output: {
        results: [{ ref: { kind: 'poi', id: 'sicily-a' }, poiId: 'sicily-a', crowdLevel: 2 }],
      },
      summary: '1 point(s) of interest in sicily',
    });
    expect(ctx.evidence.has({ kind: 'poi', id: 'crete-b' })).toBe(false);
  });

  it('forwards the query to the repository', async () => {
    const knowledge = new FakeKnowledge();
    await searchPoisTool.run(
      { destinationId: 'crete', kinds: [], maxCrowdLevel: null, month: null, limit: 3 },
      context({ knowledge }),
    );
    expect(knowledge.poiQueries).toEqual([
      { destinationId: 'crete', kinds: [], maxCrowdLevel: null, month: null, limit: 3 },
    ]);
  });

  it('rejects unknown kinds', async () => {
    const result = await searchPoisTool.run(
      { destinationId: 'crete', kinds: ['casino'], maxCrowdLevel: null, month: null, limit: null },
      context(),
    );
    expect(result).toMatchObject({ ok: false, error: expect.stringContaining('kinds[0]') });
  });

  it('reports an empty result', async () => {
    const result = await searchPoisTool.run(
      { destinationId: 'crete', kinds: ['museum'], maxCrowdLevel: null, month: null, limit: null },
      context(),
    );
    expect(result).toMatchObject({ ok: true, summary: 'No point of interest found in crete' });
  });
});

describe('excerpt', () => {
  it('trims and keeps short texts whole', () => {
    expect(excerpt('  short  ', 10)).toBe('short');
    expect(excerpt('abcdefghijkl', 6)).toBe('abcde…');
  });
});
