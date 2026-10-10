import { EMPTY_TRIP_BRIEF, type AgentResponse } from '@wanderly/contracts';
import { describe, expect, it, vi } from 'vitest';
import { TEST_PRICING, fakeLlm, llmResponse } from '../../test/agent-fakes.js';
import { ANSWER, SOURCES } from '../../test/application-fakes.js';
import type { LlmRequest } from '../domain/ports/llm.js';
import { costUsd } from '../domain/pricing.js';
import {
  MAX_TITLE_LENGTH,
  citationsResolved,
  citedRefs,
  isBudgetExhausted,
  isoDate,
  meterLlm,
  titleFrom,
  utcDayBounds,
} from './run-accounting.js';

const ITINERARY: AgentResponse = {
  type: 'itinerary',
  message: 'Here is your trip.',
  brief: EMPTY_TRIP_BRIEF,
  itinerary: {
    destinationId: 'sicily',
    title: 'Sicily in spring',
    summary: 'Two easy days.',
    month: 5,
    durationDays: 2,
    travelers: 2,
    budget: null,
    weather: null,
    assumptions: [],
    warnings: [],
    days: [1, 2].map((day) => ({
      day,
      theme: `Day ${day}`,
      items: [
        {
          slot: 'morning' as const,
          title: 'Walk',
          poiId: null,
          description: 'A walk.',
          justification: 'You like walking.',
          sourceRefs: [
            { kind: day === 1 ? ('chunk' as const) : ('poi' as const), id: `ref-${day}` },
          ],
        },
      ],
    })),
  },
};

describe('utcDayBounds / isoDate', () => {
  it('returns the UTC day containing the instant, whatever the local offset', () => {
    const now = new Date('2026-10-10T23:30:00.000-05:00'); // 04:30 UTC on the 11th
    expect(utcDayBounds(now)).toEqual({
      from: new Date('2026-10-11T00:00:00.000Z'),
      to: new Date('2026-10-12T00:00:00.000Z'),
    });
    expect(isoDate(now)).toBe('2026-10-11');
  });

  it('includes midnight in the day it starts', () => {
    const { from, to } = utcDayBounds(new Date('2026-10-10T00:00:00.000Z'));
    expect(from.toISOString()).toBe('2026-10-10T00:00:00.000Z');
    expect(to.toISOString()).toBe('2026-10-11T00:00:00.000Z');
  });
});

describe('isBudgetExhausted', () => {
  it('reserves the per-run ceiling before starting a run', () => {
    expect(isBudgetExhausted(1.9, 0.05, 2)).toBe(false);
    expect(isBudgetExhausted(1.95, 0.05, 2)).toBe(false);
    expect(isBudgetExhausted(1.96, 0.05, 2)).toBe(true);
  });

  it('blocks everything with a zero cap', () => {
    expect(isBudgetExhausted(0, 0.05, 0)).toBe(true);
  });
});

describe('citations', () => {
  it('collects the references of itinerary items and answers only', () => {
    expect(citedRefs(ITINERARY)).toEqual([
      { kind: 'chunk', id: 'ref-1' },
      { kind: 'poi', id: 'ref-2' },
    ]);
    expect(citedRefs(ANSWER)).toEqual([{ kind: 'chunk', id: 'chunk-1' }]);
    expect(
      citedRefs({
        type: 'decline',
        reason: 'out_of_scope',
        message: 'No.',
        brief: EMPTY_TRIP_BRIEF,
      }),
    ).toEqual([]);
    expect(
      citedRefs({
        type: 'clarification',
        message: 'When?',
        questions: ['Which month?'],
        brief: EMPTY_TRIP_BRIEF,
      }),
    ).toEqual([]);
  });

  it('requires every cited reference to match a shown source by kind and id', () => {
    expect(citationsResolved(ANSWER, SOURCES)).toBe(true);
    expect(citationsResolved(ANSWER, [])).toBe(false);
    const sameIdOtherKind = SOURCES.map((source) => ({ ...source, kind: 'poi' as const }));
    expect(citationsResolved(ANSWER, sameIdOtherKind)).toBe(false);
  });
});

describe('titleFrom', () => {
  it('collapses whitespace into one line', () => {
    expect(titleFrom('  Sicily\n\nin   May ')).toBe('Sicily in May');
  });

  it(`truncates to ${MAX_TITLE_LENGTH} characters with an ellipsis`, () => {
    expect(titleFrom('x'.repeat(MAX_TITLE_LENGTH + 1))).toBe(
      `${'x'.repeat(MAX_TITLE_LENGTH - 1)}…`,
    );
    const words = titleFrom('word '.repeat(40));
    expect(words.length).toBeLessThanOrEqual(MAX_TITLE_LENGTH);
    expect(words.endsWith('word…')).toBe(true);
    expect(titleFrom('x'.repeat(MAX_TITLE_LENGTH))).toBe('x'.repeat(MAX_TITLE_LENGTH));
  });
});

describe('meterLlm', () => {
  const request: LlmRequest = { system: 's', tools: [], messages: [], maxTokens: 10 };

  it('forwards calls unchanged and accumulates their usage and cost', async () => {
    const generate = vi.fn(async () => llmResponse());
    const metered = meterLlm(fakeLlm(generate), {
      signal: new AbortController().signal,
      costOf: (usage) => costUsd(usage, TEST_PRICING),
    });

    expect(metered.port).toMatchObject({ provider: 'fake', model: 'fake-model' });
    await metered.port.generate(request, { signal: new AbortController().signal });
    await metered.port.generate(request, { signal: new AbortController().signal });

    expect(generate).toHaveBeenCalledWith(
      request,
      expect.objectContaining({ signal: expect.any(AbortSignal) }),
    );
    expect(metered.usage()).toEqual({
      inputTokens: 2_000,
      outputTokens: 400,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
    });
    expect(metered.costUsd()).toBeCloseTo((2_000 * 0.1 + 400 * 0.5) / 1_000_000, 12);
  });

  it("aborts a call on either the caller's deadline or the run's cancellation", async () => {
    const seen: AbortSignal[] = [];
    const llm = fakeLlm(async (_request, { signal }) => {
      seen.push(signal);
      return llmResponse();
    });
    const run = new AbortController();
    const metered = meterLlm(llm, {
      signal: run.signal,
      costOf: (usage) => costUsd(usage, TEST_PRICING),
    });
    const deadline = new AbortController();

    await metered.port.generate(request, { signal: deadline.signal });
    await metered.port.generate(request, { signal: new AbortController().signal });
    deadline.abort();
    run.abort();

    expect(seen[0]?.aborted).toBe(true);
    expect(seen[1]?.aborted).toBe(true);
  });

  it('does not count failed calls', async () => {
    const metered = meterLlm(
      fakeLlm(async () => {
        throw new Error('overloaded');
      }),
      { signal: new AbortController().signal, costOf: (usage) => costUsd(usage, TEST_PRICING) },
    );

    await expect(
      metered.port.generate(request, { signal: new AbortController().signal }),
    ).rejects.toThrow('overloaded');
    expect(metered.costUsd()).toBe(0);
  });
});
