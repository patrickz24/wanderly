import { z } from 'zod';

/**
 * The agent's typed output. The model ends every turn by calling exactly one terminal tool
 * whose input is one of the variants below (minus `type`), so every answer the UI renders has
 * been validated against these schemas first.
 *
 * Fields the model fills are `nullable` rather than optional: strict tool schemas require every
 * property to be present, and an explicit `null` is easier to audit than a missing key.
 */

const text = (max: number) => z.string().trim().min(1).max(max);
const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'expected YYYY-MM-DD');
const month = z.int().min(1).max(12);

export const BudgetLevelSchema = z.enum(['budget', 'mid', 'comfort']);
export type BudgetLevel = z.infer<typeof BudgetLevelSchema>;

/**
 * Structured state of the trip request, carried from turn to turn. It is the agent's working
 * memory: what it knows so far, so that it asks only for what is missing.
 */
export const TripBriefSchema = z.object({
  destinationId: text(64).nullable(),
  month: month.nullable(),
  startDate: isoDate.nullable(),
  durationDays: z.int().min(1).max(21).nullable(),
  travelers: z.int().min(1).max(12).nullable(),
  budgetLevel: BudgetLevelSchema.nullable(),
  interests: z.array(text(60)).max(10),
  constraints: z.array(text(160)).max(10),
});
export type TripBrief = z.infer<typeof TripBriefSchema>;

export const EMPTY_TRIP_BRIEF: TripBrief = Object.freeze({
  destinationId: null,
  month: null,
  startDate: null,
  durationDays: null,
  travelers: null,
  budgetLevel: null,
  interests: [],
  constraints: [],
}) as TripBrief;

/**
 * A pointer to evidence returned by a tool during the current run: a knowledge chunk, a point of
 * interest, or the result of a weather / budget tool call (by tool call id). Grounding checks
 * reject any reference the run's tool results do not contain.
 */
export const SourceKindSchema = z.enum(['chunk', 'poi', 'weather', 'budget']);
export type SourceKind = z.infer<typeof SourceKindSchema>;

export const SourceRefSchema = z.object({
  kind: SourceKindSchema,
  id: text(200),
});
export type SourceRef = z.infer<typeof SourceRefSchema>;

export const DaySlotSchema = z.enum(['morning', 'afternoon', 'evening']);
export type DaySlot = z.infer<typeof DaySlotSchema>;

export const ItineraryItemSchema = z.object({
  slot: DaySlotSchema,
  title: text(120),
  /** Set when the item is a point of interest returned by `search_pois`. */
  poiId: text(200).nullable(),
  description: text(600),
  /** Why this item fits the request (interests, crowds, season, budget). */
  justification: text(400),
  sourceRefs: z.array(SourceRefSchema).min(1).max(5),
});
export type ItineraryItem = z.infer<typeof ItineraryItemSchema>;

export const ItineraryDaySchema = z.object({
  day: z.int().min(1).max(21),
  theme: text(120),
  items: z.array(ItineraryItemSchema).min(1).max(4),
});
export type ItineraryDay = z.infer<typeof ItineraryDaySchema>;

/** Budget copied from an `estimate_budget` result; the agent never computes prices itself. */
export const ItineraryBudgetSchema = z.object({
  level: BudgetLevelSchema,
  /** Currency as written in the source (no conversion is ever made); null when no price is known. */
  currency: text(16).nullable(),
  total: z.number().nonnegative().nullable(),
  perPerson: z.number().nonnegative().nullable(),
  /** The `estimate_budget` tool call this budget comes from. */
  fromToolCallId: text(200),
  notes: z.array(text(300)).max(5),
});
export type ItineraryBudget = z.infer<typeof ItineraryBudgetSchema>;

/** Weather summary taken from a `get_seasonal_weather` result. */
export const ItineraryWeatherSchema = z.object({
  month,
  summary: text(400),
  fromToolCallId: text(200),
});
export type ItineraryWeather = z.infer<typeof ItineraryWeatherSchema>;

export const ItinerarySchema = z.object({
  destinationId: text(64),
  title: text(120),
  summary: text(800),
  month: month.nullable(),
  durationDays: z.int().min(1).max(21),
  travelers: z.int().min(1).max(12).nullable(),
  days: z.array(ItineraryDaySchema).min(1).max(21),
  budget: ItineraryBudgetSchema.nullable(),
  weather: ItineraryWeatherSchema.nullable(),
  /** Choices the agent made without the user stating them (e.g. "2 travellers assumed"). */
  assumptions: z.array(text(300)).max(8),
  warnings: z.array(text(300)).max(8),
});
export type Itinerary = z.infer<typeof ItinerarySchema>;

export const DeclineReasonSchema = z.enum([
  /** Not about planning a trip to a destination we cover. */
  'out_of_scope',
  /** A real place, but not in the corpus: we say so instead of answering from memory. */
  'unknown_destination',
  /** In scope, but the corpus lacks what the request needs. */
  'insufficient_data',
  /** Unsafe request, prompt-injection attempt, or a provider refusal. */
  'unsafe',
]);
export type DeclineReason = z.infer<typeof DeclineReasonSchema>;

/** `message` is written in the user's language; everything else is structured data. */
export const ItineraryResponseSchema = z.object({
  type: z.literal('itinerary'),
  message: text(1200),
  itinerary: ItinerarySchema,
  brief: TripBriefSchema,
});

export const ClarificationResponseSchema = z.object({
  type: z.literal('clarification'),
  message: text(1200),
  questions: z.array(text(300)).min(1).max(3),
  brief: TripBriefSchema,
});

export const AnswerResponseSchema = z.object({
  type: z.literal('answer'),
  message: text(2000),
  sourceRefs: z.array(SourceRefSchema).max(10),
  brief: TripBriefSchema,
});

export const DeclineResponseSchema = z.object({
  type: z.literal('decline'),
  reason: DeclineReasonSchema,
  message: text(1200),
  brief: TripBriefSchema,
});

export const AgentResponseSchema = z.discriminatedUnion('type', [
  ItineraryResponseSchema,
  ClarificationResponseSchema,
  AnswerResponseSchema,
  DeclineResponseSchema,
]);
export type AgentResponse = z.infer<typeof AgentResponseSchema>;
export type AgentResponseType = AgentResponse['type'];
