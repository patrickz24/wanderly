import { EMPTY_TRIP_BRIEF, type TripBrief } from '@wanderly/contracts';
import { z } from 'zod';
import type { ModelPricing } from '../../services/api/src/domain/agent/types.js';
import {
  ZERO_USAGE,
  type AssistantBlock,
  type LlmMessage,
  type LlmRequest,
  type LlmResponse,
} from '../../services/api/src/domain/ports/llm.js';
import type { AgentCase } from './agent-dataset.js';

/**
 * Control policies that stand in for the model (plan section 8.3, audit "harness tested on
 * known-good and known-bad"). They run through the REAL agent loop, tools and guardrails:
 *
 * - `oracle`: calls the data tools, then builds the gold-conforming terminal call of the case
 *   from what the tools returned. The deterministic scorers must rate it near 100 %.
 * - `null-decline`: a constant answer (declines everything as out of scope). Must fail.
 * - `null-empty`: answers with empty text, never a terminal tool. Must fail.
 *
 * They need no API key and cost nothing; their usage is zero by construction.
 */
export const BASELINE_POLICIES = ['oracle', 'null-decline', 'null-empty'] as const;
export type BaselinePolicy = (typeof BASELINE_POLICIES)[number];

export const ZERO_PRICING: ModelPricing = {
  inputPerMTok: 0,
  outputPerMTok: 0,
  cacheReadPerMTok: 0,
  cacheWritePerMTok: 0,
};

export function baselinePolicy(
  policy: BaselinePolicy,
  testCase: AgentCase,
): (request: LlmRequest) => LlmResponse {
  switch (policy) {
    case 'oracle':
      return (request) => oracleStep(testCase, request);
    case 'null-decline':
      return () =>
        respond(policy, [
          terminal('null-decline', 'decline', {
            reason: 'out_of_scope',
            message: 'I cannot help with that.',
            brief: EMPTY_TRIP_BRIEF,
          }),
        ]);
    case 'null-empty':
      return () => respond(policy, [{ type: 'text', text: '' }]);
  }
}

function respond(model: string, content: readonly AssistantBlock[]): LlmResponse {
  return {
    content,
    stopReason: content.some((block) => block.type === 'tool_call') ? 'tool_use' : 'end_turn',
    usage: ZERO_USAGE,
    model,
    providerRequestId: null,
  };
}

let callCounter = 0;
function terminal(prefix: string, name: string, input: unknown): AssistantBlock {
  callCounter += 1;
  return { type: 'tool_call', id: `${prefix}-${callCounter}`, name, input };
}

// --- Oracle ---------------------------------------------------------------------------------------

const CONTEXT_PREFIX = '<context>';

/** 1-based index of the turn being answered (user messages that carry a context block). */
function turnIndex(messages: readonly LlmMessage[]): number {
  return messages.filter(
    (message) =>
      message.role === 'user' &&
      message.content.some(
        (block) => block.type === 'text' && block.text.startsWith(CONTEXT_PREFIX),
      ),
  ).length;
}

function lastUserStartsTurn(messages: readonly LlmMessage[]): boolean {
  const last = messages.at(-1);
  return (
    last?.role === 'user' &&
    last.content.some((block) => block.type === 'text' && block.text.startsWith(CONTEXT_PREFIX))
  );
}

function oracleStep(testCase: AgentCase, request: LlmRequest): LlmResponse {
  const turn = turnIndex(request.messages);
  const finalTurn = turn >= testCase.turns.length;
  const expect = testCase.expect;
  const fr = testCase.language === 'fr';
  if (!finalTurn) {
    return respond('oracle', [
      terminal('oracle', 'ask_clarification', {
        message: fr ? 'Quelques précisions ?' : 'A few details?',
        questions: [fr ? 'Pouvez-vous préciser ?' : 'Could you tell me more?'],
        brief: EMPTY_TRIP_BRIEF,
      }),
    ]);
  }
  const preferred = expect.types[0];
  if (preferred === 'clarification') {
    return respond('oracle', [
      terminal('oracle', 'ask_clarification', {
        message: fr ? 'Il me manque quelques informations.' : 'I need a few details first.',
        questions: [fr ? 'Combien de jours, et à quelle période ?' : 'How many days, and when?'],
        brief: { ...EMPTY_TRIP_BRIEF, destinationId: expect.destinationId ?? null },
      }),
    ]);
  }
  if (preferred === 'decline' || preferred === 'answer' || preferred === undefined) {
    return respond('oracle', [
      terminal('oracle', 'decline', {
        reason: expect.declineReasons?.[0] ?? 'unsafe',
        message: fr
          ? 'Je ne peux pas vous aider pour cela, mais je peux planifier un voyage.'
          : 'I cannot help with that, but I can plan a trip to a destination I cover.',
        brief: EMPTY_TRIP_BRIEF,
      }),
    ]);
  }
  return lastUserStartsTurn(request.messages)
    ? gatherTools(testCase, turn)
    : presentItinerary(testCase, request.messages, turn);
}

const INTEREST_WORDS: Readonly<Record<string, string>> = {
  historic_site: 'history historic old town castle',
  religious_site: 'church cathedral monastery',
  boat_trip: 'boat trip cruise',
  family: 'children family',
  food: 'food restaurant cuisine',
};

function gatherTools(testCase: AgentCase, turn: number): LlmResponse {
  const expect = testCase.expect;
  const destinationId = expect.destinationId ?? '';
  const interests = expect.interests ?? [];
  const query = interests.map((interest) => INTEREST_WORDS[interest] ?? interest).join(' ');
  const calls: AssistantBlock[] = [
    call(turn, 'k', 'search_knowledge', {
      query: query.length >= 3 ? query : 'things to see and do',
      destinationId,
      limit: null,
    }),
    // One search per interest, so every interest has POIs to choose from.
    ...(interests.length === 0 ? [null] : interests).map((kind, index) =>
      call(turn, `p${index}`, 'search_pois', {
        destinationId,
        kinds: kind === null ? [] : [kind],
        maxCrowdLevel: null,
        month: expect.month ?? null,
        limit: 5,
      }),
    ),
  ];
  if (expect.month !== undefined) {
    calls.push(call(turn, 'w', 'get_seasonal_weather', { destinationId, month: expect.month }));
  }
  if (expect.budgetLevel !== undefined) {
    calls.push(
      call(turn, 'b', 'estimate_budget', {
        destinationId,
        days: expect.durationDays ?? 3,
        travelers: expect.travelers ?? 2,
        level: expect.budgetLevel,
      }),
    );
  }
  return respond('oracle', calls);
}

function call(turn: number, key: string, name: string, input: unknown): AssistantBlock {
  return { type: 'tool_call', id: `oracle-t${turn}-${key}`, name, input };
}

const PoisResult = z.object({
  results: z.array(z.object({ poiId: z.string(), name: z.string(), kinds: z.array(z.string()) })),
});
const KnowledgeResult = z.object({
  results: z.array(z.object({ ref: z.object({ kind: z.literal('chunk'), id: z.string() }) })),
});
const WeatherResult = z.object({
  found: z.literal(true),
  weatherId: z.string(),
  month: z.int(),
  avgHighC: z.number(),
  avgLowC: z.number(),
});
const BudgetResult = z.object({
  estimateId: z.string(),
  level: z.enum(['budget', 'mid', 'comfort']),
  currency: z.string().nullable(),
  total: z.number().nullable(),
  perPerson: z.number().nullable(),
});

function resultOf<T>(messages: readonly LlmMessage[], id: string, schema: z.ZodType<T>): T | null {
  for (const message of messages) {
    if (message.role !== 'user') continue;
    for (const block of message.content) {
      if (block.type === 'tool_result' && block.toolCallId === id && !block.isError) {
        const parsed = schema.safeParse(JSON.parse(block.content));
        return parsed.success ? parsed.data : null;
      }
    }
  }
  return null;
}

function presentItinerary(
  testCase: AgentCase,
  messages: readonly LlmMessage[],
  turn: number,
): LlmResponse {
  const expect = testCase.expect;
  const fr = testCase.language === 'fr';
  const destinationId = expect.destinationId ?? '';
  const durationDays = expect.durationDays ?? 3;
  const interests = expect.interests ?? [];
  const pois = Array.from(
    { length: Math.max(1, interests.length) },
    (_, index) => resultOf(messages, `oracle-t${turn}-p${index}`, PoisResult)?.results ?? [],
  ).flat();
  const chunk = resultOf(messages, `oracle-t${turn}-k`, KnowledgeResult)?.results[0]?.ref ?? null;
  const weather = resultOf(messages, `oracle-t${turn}-w`, WeatherResult);
  const estimate = resultOf(messages, `oracle-t${turn}-b`, BudgetResult);

  // One POI per interest first (so every interest is covered), then the rest.
  const ordered = [
    ...interests.flatMap((kind) => pois.filter((poi) => poi.kinds.includes(kind)).slice(0, 1)),
    ...pois,
  ].filter((poi, index, all) => all.findIndex((other) => other.poiId === poi.poiId) === index);
  if (ordered.length === 0) {
    return respond('oracle', [
      terminal('oracle', 'decline', {
        reason: 'insufficient_data',
        message: fr ? 'Le guide ne couvre pas cela.' : 'The guide does not cover this.',
        brief: EMPTY_TRIP_BRIEF,
      }),
    ]);
  }
  const slots = ['morning', 'afternoon'] as const;
  const days = Array.from({ length: durationDays }, (_, dayIndex) => ({
    day: dayIndex + 1,
    theme: fr ? `Jour ${dayIndex + 1}` : `Day ${dayIndex + 1}`,
    items: slots.map((slot, slotIndex) => {
      const poi = ordered[(dayIndex * slots.length + slotIndex) % ordered.length] ?? ordered[0];
      const name = (poi?.name ?? destinationId).slice(0, 100);
      return {
        slot,
        title: name,
        poiId: poi?.poiId ?? null,
        description: fr ? `Visite : ${name}.` : `Visit ${name}.`,
        justification: fr
          ? `Correspond à vos centres d'intérêt (${(poi?.kinds ?? []).join(', ')}).`
          : `Matches your interests (${(poi?.kinds ?? []).join(', ')}).`,
        sourceRefs: [
          ...(poi === undefined ? [] : [{ kind: 'poi', id: poi.poiId }]),
          ...(chunk === null ? [] : [chunk]),
        ],
      };
    }),
  }));
  const budget =
    estimate === null
      ? null
      : {
          level: estimate.level,
          currency: estimate.currency,
          total: estimate.total,
          perPerson: estimate.perPerson,
          fromToolCallId: estimate.estimateId,
          notes: [],
        };
  const brief: TripBrief = {
    ...EMPTY_TRIP_BRIEF,
    destinationId,
    month: expect.month ?? null,
    durationDays,
    travelers: expect.travelers ?? null,
    budgetLevel: budget?.level ?? null,
    interests: [...interests],
  };
  return respond('oracle', [
    terminal('oracle', 'present_itinerary', {
      message: fr ? 'Voici votre itinéraire.' : 'Here is your itinerary.',
      brief,
      itinerary: {
        destinationId,
        title: fr ? 'Votre voyage' : 'Your trip',
        summary: fr
          ? 'Itinéraire construit à partir du guide.'
          : 'An itinerary built from the guide.',
        month: expect.month ?? null,
        durationDays,
        travelers: expect.travelers ?? null,
        days,
        budget,
        weather:
          weather === null
            ? null
            : {
                month: weather.month,
                summary: `${weather.avgHighC} °C / ${weather.avgLowC} °C`,
                fromToolCallId: weather.weatherId,
              },
        assumptions: [],
        warnings:
          budget !== null && budget.total === null
            ? [fr ? 'Le guide ne donne pas tous les prix.' : 'The guide lacks some prices.']
            : [],
      },
    }),
  ]);
}
