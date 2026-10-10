import { describe, expect, it } from 'vitest';
import {
  AgentResponseSchema,
  EMPTY_TRIP_BRIEF,
  ItinerarySchema,
  TripBriefSchema,
  type Itinerary,
} from './agent.js';

const itinerary: Itinerary = {
  destinationId: 'sicily',
  title: 'A quiet week in Sicily',
  summary: 'Hiking and villages away from the busiest spots.',
  month: 5,
  durationDays: 1,
  travelers: 2,
  days: [
    {
      day: 1,
      theme: 'Etna slopes',
      items: [
        {
          slot: 'morning',
          title: 'Hike on Mount Etna',
          poiId: 'sicily-mount-etna',
          description: 'Guided walk on the northern slopes.',
          justification: 'You like hiking; the north side is less crowded.',
          sourceRefs: [{ kind: 'poi', id: 'sicily-mount-etna' }],
        },
      ],
    },
  ],
  budget: {
    level: 'mid',
    currency: '€',
    total: 840,
    perPerson: 420,
    fromToolCallId: 'toolu_01',
    notes: [],
  },
  weather: { month: 5, summary: 'Mild, 23°C highs.', fromToolCallId: 'toolu_02' },
  assumptions: ['2 travellers assumed'],
  warnings: [],
};

describe('TripBriefSchema', () => {
  it('accepts the empty brief', () => {
    expect(TripBriefSchema.parse(EMPTY_TRIP_BRIEF)).toEqual(EMPTY_TRIP_BRIEF);
  });

  it('rejects an out-of-range month', () => {
    expect(TripBriefSchema.safeParse({ ...EMPTY_TRIP_BRIEF, month: 13 }).success).toBe(false);
  });
});

describe('ItinerarySchema', () => {
  it('accepts a complete itinerary', () => {
    expect(ItinerarySchema.parse(itinerary)).toEqual(itinerary);
  });

  it('requires at least one source per item', () => {
    const [day] = itinerary.days;
    const [item] = day!.items;
    const broken = { ...itinerary, days: [{ ...day!, items: [{ ...item!, sourceRefs: [] }] }] };
    expect(ItinerarySchema.safeParse(broken).success).toBe(false);
  });

  it('rejects a missing nullable field instead of treating it as null', () => {
    const { budget: _budget, ...withoutBudget } = itinerary;
    expect(ItinerarySchema.safeParse(withoutBudget).success).toBe(false);
  });
});

describe('AgentResponseSchema', () => {
  it('discriminates on type', () => {
    const parsed = AgentResponseSchema.parse({
      type: 'clarification',
      message: 'When do you want to travel?',
      questions: ['Which month?'],
      brief: EMPTY_TRIP_BRIEF,
    });
    expect(parsed.type).toBe('clarification');
  });

  it('rejects an unknown decline reason', () => {
    const result = AgentResponseSchema.safeParse({
      type: 'decline',
      reason: 'bored',
      message: 'No.',
      brief: EMPTY_TRIP_BRIEF,
    });
    expect(result.success).toBe(false);
  });

  it('caps clarification questions at three', () => {
    const result = AgentResponseSchema.safeParse({
      type: 'clarification',
      message: 'A few questions.',
      questions: ['a?', 'b?', 'c?', 'd?'],
      brief: EMPTY_TRIP_BRIEF,
    });
    expect(result.success).toBe(false);
  });
});
