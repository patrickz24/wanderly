import { reply, thinking, toolCall } from './fake-llm.js';
import type { LlmResponse } from '../../src/domain/ports/llm.js';
import { brief } from './agent-fakes.js';

/**
 * Scripted model turns for the agent tests: a 2-day hiking trip to Sicily in May for two
 * travellers at the mid level. Budget arithmetic with the fake corpus: 1 night × 1 room × 100 EUR
 * + 2 meals × 2 days × 2 travellers × 25 EUR = 300 EUR, 150 EUR per person.
 */

export const SICILY_BRIEF = brief({
  destinationId: 'sicily',
  month: 5,
  durationDays: 2,
  travelers: 2,
  budgetLevel: 'mid',
  interests: ['hiking'],
});

/** Step 1: four data tools in parallel (with a signed thinking block first). */
export function gatherStep(signature = 'sig-gather'): LlmResponse {
  return reply([
    thinking(signature),
    toolCall('k1', 'search_knowledge', {
      query: 'quiet hiking trails',
      destinationId: 'sicily',
      limit: null,
    }),
    toolCall('p1', 'search_pois', {
      destinationId: 'sicily',
      kinds: ['hiking'],
      maxCrowdLevel: null,
      month: 5,
      limit: null,
    }),
    toolCall('w1', 'get_seasonal_weather', { destinationId: 'sicily', month: 5 }),
    toolCall('b1', 'estimate_budget', {
      destinationId: 'sicily',
      days: 2,
      travelers: 2,
      level: 'mid',
    }),
  ]);
}

export interface ItineraryOptions {
  readonly days?: number;
  readonly durationDays?: number;
  readonly chunkId?: string;
  readonly poiId?: string | null;
  readonly total?: number | null;
  readonly message?: string;
}

export function itineraryInput(options: ItineraryOptions = {}) {
  const durationDays = options.durationDays ?? 2;
  const dayCount = options.days ?? durationDays;
  return {
    message: options.message ?? 'Voici votre itinéraire de randonnée en Sicile.',
    itinerary: {
      destinationId: 'sicily',
      title: 'Hiking in Sicily',
      summary: 'Two quiet hiking days.',
      month: 5,
      durationDays,
      travelers: 2,
      days: Array.from({ length: dayCount }, (_, index) => ({
        day: index + 1,
        theme: `Day ${index + 1}`,
        items: [
          {
            slot: 'morning',
            title: 'Madonie trails',
            poiId: options.poiId === undefined ? 'sicily-madonie' : options.poiId,
            description: 'A walk in the Madonie park.',
            justification: 'Quiet trails for hikers.',
            sourceRefs: [{ kind: 'chunk', id: options.chunkId ?? 'chunk-sicily-hiking' }],
          },
        ],
      })),
      budget: {
        level: 'mid',
        currency: 'EUR',
        total: options.total === undefined ? 300 : options.total,
        perPerson: 150,
        fromToolCallId: 'b1',
        notes: [],
      },
      weather: { month: 5, summary: 'Warm and mostly dry.', fromToolCallId: 'w1' },
      assumptions: [],
      warnings: [],
    },
    brief: { ...SICILY_BRIEF, durationDays },
  };
}

export function presentStep(id = 't1', options: ItineraryOptions = {}): LlmResponse {
  return reply([thinking(`sig-${id}`), toolCall(id, 'present_itinerary', itineraryInput(options))]);
}

export function clarificationInput() {
  return {
    message: 'A few questions first.',
    questions: ['Which month do you plan to travel?'],
    brief: brief({ destinationId: 'sicily' }),
  };
}

export function clarificationStep(id = 'c1'): LlmResponse {
  return reply([toolCall(id, 'ask_clarification', clarificationInput())]);
}

export function answerStep(
  id: string,
  sourceRefs: ReadonlyArray<{ kind: string; id: string }>,
  message = 'The Madonie park has quiet trails.',
): LlmResponse {
  return reply([
    toolCall(id, 'answer_question', {
      message,
      sourceRefs,
      brief: brief({ destinationId: 'sicily' }),
    }),
  ]);
}

export function declineStep(id: string, reason: string): LlmResponse {
  return reply([
    toolCall(id, 'decline', {
      message: 'Sorry, I cannot help with that.',
      reason,
      brief: brief(),
    }),
  ]);
}
