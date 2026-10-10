import type { AgentResponse, Itinerary } from '@wanderly/contracts';
import { describe, expect, it } from 'vitest';
import {
  CHUNKS,
  CLIMATE,
  COSTS,
  DESTINATIONS,
  POIS,
  poi,
} from '../../../test/support/agent-fakes.js';
import { itineraryInput } from '../../../test/support/agent-scenarios.js';
import { createCatalog } from '../agent/catalog.js';
import { estimateBudget } from '../tools/budget.js';
import { EvidenceRegistry } from '../tools/evidence.js';
import { presentItineraryTool } from '../tools/terminal-tools.js';
import { checkConsistency } from './consistency.js';
import { checkGrounding } from './grounding.js';
import { citedRefs, resolveSources } from './sources.js';
import { validateResponse } from './validate-response.js';

const catalog = createCatalog(DESTINATIONS);

function evidence(): EvidenceRegistry {
  const registry = new EvidenceRegistry();
  registry.recordChunks(CHUNKS);
  registry.recordPois(POIS);
  registry.recordWeather({ callId: 'w1', fact: CLIMATE[0]! });
  registry.recordBudget({
    callId: 'b1',
    estimate: estimateBudget(COSTS[0]!, {
      destinationId: 'sicily',
      days: 2,
      travelers: 2,
      level: 'mid',
    }),
  });
  return registry;
}

function itineraryResponse(
  change: (itinerary: Itinerary) => Itinerary = (it) => it,
): AgentResponse {
  const parsed = presentItineraryTool.parse(itineraryInput());
  if (!parsed.ok || parsed.response.type !== 'itinerary') throw new Error('fixture must be valid');
  return { ...parsed.response, itinerary: change(parsed.response.itinerary) };
}

describe('validateResponse', () => {
  it('accepts a consistent, grounded itinerary', () => {
    expect(validateResponse(itineraryResponse(), { evidence: evidence(), catalog })).toEqual([]);
  });

  it('reports consistency issues before grounding issues', () => {
    const response = itineraryResponse((it) => ({ ...it, destinationId: 'lisbon' }));
    const issues = validateResponse(response, { evidence: evidence(), catalog });
    expect(issues[0]).toContain(
      'itinerary.destinationId: "lisbon" is not in the destination catalog',
    );
  });
});

describe('checkConsistency', () => {
  it('requires one day per durationDays, numbered in order', () => {
    const short = itineraryResponse((it) => ({ ...it, days: it.days.slice(0, 1) }));
    expect(checkConsistency(short, catalog)).toEqual([
      'itinerary.days: has 1 day(s) but durationDays is 2; provide exactly one entry per day.',
    ]);
    const swapped = itineraryResponse((it) => ({ ...it, days: [...it.days].reverse() }));
    expect(checkConsistency(swapped, catalog)[0]).toContain(
      'itinerary.days[0].day: is 2, expected 1',
    );
  });

  it('requires the brief to agree with the itinerary', () => {
    const response = itineraryResponse();
    const issues = checkConsistency(
      {
        ...response,
        brief: {
          ...response.brief,
          destinationId: 'crete',
          durationDays: 3,
          month: 6,
          travelers: 4,
        },
      },
      catalog,
    );
    expect(issues).toEqual([
      'brief.destinationId: must be "sicily", the destination of the itinerary.',
      'brief.durationDays: must be 2, as in the itinerary.',
      'brief.month: 6 differs from the itinerary month 5.',
      'brief.travelers: 4 differs from the itinerary travelers 2.',
    ]);
  });

  it('rejects a brief destination outside the catalog for every response type', () => {
    const decline: AgentResponse = {
      type: 'decline',
      reason: 'unknown_destination',
      message: 'Lisbon is not covered.',
      brief: { ...itineraryResponse().brief, destinationId: 'lisbon' },
    };
    expect(checkConsistency(decline, catalog)[0]).toContain('brief.destinationId: "lisbon"');
    expect(
      checkConsistency({ ...decline, brief: { ...decline.brief, destinationId: null } }, catalog),
    ).toEqual([]);
  });
});

describe('checkGrounding', () => {
  it('rejects refs and POIs no tool returned in this run', () => {
    const response = itineraryResponse((it) => ({
      ...it,
      days: it.days.map((day) => ({
        ...day,
        items: day.items.map((item) => ({
          ...item,
          poiId: 'sicily-invented',
          sourceRefs: [{ kind: 'poi', id: 'x' }],
        })),
      })),
    }));
    const issues = checkGrounding(response, evidence());
    expect(issues).toContain(
      'itinerary.days[0].items[0].poiId: "sicily-invented" was not returned by search_pois in this turn. Use a returned poiId or null.',
    );
    expect(issues.some((issue) => issue.includes('no poi with id "x"'))).toBe(true);
  });

  it('rejects POIs and excerpts of another destination', () => {
    const registry = evidence();
    registry.recordPois([poi('crete-samaria', 'crete', ['hiking'])]);
    const response = itineraryResponse((it) => ({
      ...it,
      days: it.days.map((day) => ({
        ...day,
        items: day.items.map((item) => ({
          ...item,
          poiId: 'crete-samaria',
          sourceRefs: [{ kind: 'chunk', id: 'chunk-crete-gorge' }],
        })),
      })),
    }));
    const issues = checkGrounding(response, registry);
    expect(issues).toContain(
      'itinerary.days[0].items[0].poiId: "crete-samaria" belongs to crete, not sicily.',
    );
    expect(issues).toContain(
      'itinerary.days[0].items[0].sourceRefs: excerpt chunk-crete-gorge is about crete, not sicily.',
    );
  });

  it('requires the budget to be the estimate it cites', () => {
    const wrong = itineraryResponse((it) => ({
      ...it,
      budget:
        it.budget === null
          ? null
          : { ...it.budget, level: 'budget', currency: 'USD', perPerson: 140 },
    }));
    expect(checkGrounding(wrong, evidence())).toEqual([
      'itinerary.budget.level: must be copied from the estimate ("mid"), got "budget".',
      'itinerary.budget.currency: must be copied from the estimate ("EUR"), got "USD".',
      'itinerary.budget.perPerson: must be copied from the estimate (150), got 140.',
    ]);
    const unknown = itineraryResponse((it) => ({
      ...it,
      budget: it.budget === null ? null : { ...it.budget, fromToolCallId: 'b404' },
    }));
    expect(checkGrounding(unknown, evidence())[0]).toContain('"b404" is not the estimateId');
  });

  it('requires the estimate to match the trip (destination, days, travellers)', () => {
    const registry = evidence();
    registry.recordBudget({
      callId: 'b1',
      estimate: estimateBudget(COSTS[0]!, {
        destinationId: 'sicily',
        days: 3,
        travelers: 1,
        level: 'mid',
      }),
    });
    const response = itineraryResponse((it) => ({
      ...it,
      budget: it.budget === null ? null : { ...it.budget, total: 350, perPerson: 350 },
    }));
    expect(checkGrounding(response, registry)).toEqual([
      'itinerary.budget: the cited estimate is for 3 day(s) but the itinerary lasts 2. Call estimate_budget with days=2.',
      'itinerary.budget: the cited estimate is for 1 traveller(s) but the itinerary has 2.',
    ]);
  });

  it('accepts a copy of an estimate without prices, but not invented figures', () => {
    const registry = evidence();
    registry.recordBudget({
      callId: 'b1',
      estimate: estimateBudget(null, {
        destinationId: 'sicily',
        days: 2,
        travelers: 2,
        level: 'mid',
      }),
    });
    const copied = itineraryResponse((it) => ({
      ...it,
      budget:
        it.budget === null
          ? null
          : { ...it.budget, currency: null, total: null, perPerson: null, notes: ['No prices.'] },
    }));
    expect(checkGrounding(copied, registry)).toEqual([]);
    expect(checkGrounding(itineraryResponse(), registry)).toEqual([
      'itinerary.budget.currency: must be copied from the estimate (null), got "EUR".',
      'itinerary.budget.total: must be copied from the estimate (null), got 300.',
      'itinerary.budget.perPerson: must be copied from the estimate (null), got 150.',
    ]);
  });

  it('requires the weather to match the cited month and destination', () => {
    const registry = evidence();
    registry.recordWeather({
      callId: 'w2',
      fact: { ...CLIMATE[0]!, destinationId: 'crete', month: 6 },
    });
    const response = itineraryResponse((it) => ({
      ...it,
      weather: it.weather === null ? null : { ...it.weather, fromToolCallId: 'w2' },
    }));
    expect(checkGrounding(response, registry)).toEqual([
      'itinerary.weather: the cited weather is for crete, not sicily.',
      'itinerary.weather.month: the cited weather is for month 6, got 5.',
    ]);
    const unknown = itineraryResponse((it) => ({
      ...it,
      weather: it.weather === null ? null : { ...it.weather, fromToolCallId: 'w404' },
    }));
    expect(checkGrounding(unknown, registry)[0]).toContain('"w404" is not the weatherId');
    const otherMonth = itineraryResponse((it) => ({ ...it, month: 6 }));
    expect(checkGrounding(otherMonth, evidence())).toEqual([
      'itinerary.weather.month: 5 differs from the itinerary month 6.',
    ]);
  });

  it('accepts an itinerary without budget and weather', () => {
    const response = itineraryResponse((it) => ({ ...it, budget: null, weather: null }));
    expect(checkGrounding(response, evidence())).toEqual([]);
  });

  it('checks answer refs and has nothing to check for clarifications and declines', () => {
    const brief = itineraryResponse().brief;
    expect(
      checkGrounding(
        { type: 'answer', message: 'm', sourceRefs: [{ kind: 'weather', id: 'w9' }], brief },
        evidence(),
      ),
    ).toHaveLength(1);
    expect(
      checkGrounding({ type: 'clarification', message: 'm', questions: ['q'], brief }, evidence()),
    ).toEqual([]);
    expect(
      checkGrounding({ type: 'decline', reason: 'unsafe', message: 'm', brief }, evidence()),
    ).toEqual([]);
  });
});

describe('sources', () => {
  it('lists cited evidence once, in order of first citation', () => {
    expect(citedRefs(itineraryResponse()).map((ref) => `${ref.kind}:${ref.id}`)).toEqual([
      'poi:sicily-madonie',
      'chunk:chunk-sicily-hiking',
      'weather:w1',
      'budget:b1',
    ]);
  });

  it('resolves evidence into display summaries', () => {
    expect(resolveSources(itineraryResponse(), evidence(), catalog)).toEqual([
      {
        kind: 'poi',
        id: 'sicily-madonie',
        title: 'sicily-madonie',
        destinationId: 'sicily',
        snippet: 'Description of sicily-madonie',
        url: null,
        license: 'CC BY-SA 4.0',
      },
      {
        kind: 'chunk',
        id: 'chunk-sicily-hiking',
        title: 'Sicily > Do',
        destinationId: 'sicily',
        snippet: 'The Madonie park has quiet hiking trails.',
        url: 'https://en.wikivoyage.org/wiki/sicily',
        license: 'CC BY-SA 4.0',
      },
      {
        kind: 'weather',
        id: 'w1',
        title: 'Climate in Sicily, May',
        destinationId: 'sicily',
        snippet: 'May: 23°C / 16.1°C, 8 rainy days, 67.4 mm',
        url: 'https://open-meteo.com/',
        license: 'Weather data by Open-Meteo.com (CC BY 4.0)',
      },
      {
        kind: 'budget',
        id: 'b1',
        title: 'Budget estimate (mid), Sicily',
        destinationId: 'sicily',
        snippet: '300 EUR for 2 traveller(s), 2 day(s)',
        url: null,
        license: 'CC BY-SA 4.0',
      },
    ]);
  });

  it('skips unknown evidence and unsafe URLs', () => {
    const registry = new EvidenceRegistry();
    registry.recordChunks([{ ...CHUNKS[0]!, sourceUrl: 'javascript:alert(1)', headingPath: ' ' }]);
    registry.recordBudget({
      callId: 'b1',
      estimate: estimateBudget(null, {
        destinationId: 'atlantis',
        days: 2,
        travelers: 2,
        level: 'mid',
      }),
    });
    const brief = itineraryResponse().brief;
    const sources = resolveSources(
      {
        type: 'answer',
        message: 'm',
        sourceRefs: [
          { kind: 'chunk', id: 'chunk-sicily-hiking' },
          { kind: 'poi', id: 'nope' },
          { kind: 'weather', id: 'nope' },
          { kind: 'budget', id: 'b1' },
          { kind: 'chunk', id: 'nope' },
          { kind: 'budget', id: 'nope' },
        ],
        brief,
      },
      registry,
      catalog,
    );
    expect(sources).toEqual([
      expect.objectContaining({ kind: 'chunk', title: 'Sicily', url: null }),
      expect.objectContaining({
        kind: 'budget',
        title: 'Budget estimate (mid), atlantis',
        snippet: 'No complete price in the guide.',
      }),
    ]);
  });
});
