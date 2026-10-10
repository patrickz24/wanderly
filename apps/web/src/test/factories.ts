import {
  EMPTY_TRIP_BRIEF,
  type AgentResponse,
  type ConversationSummary,
  type GetConversationResponse,
  type SourceSummary,
  type ToolCallSummary,
} from '@wanderly/contracts';
import type { AgentResponseOf, AssistantMessage, RunFinishedEvent, RunStats } from '../lib/types';

/** Stable, contract-valid UUIDs for tests. */
export const ids = {
  conversation: '0b6f3c1e-2d4a-4f6b-8a1c-3e5d7f9b1a20',
  otherConversation: '4fad7a5c-6b8e-4dae-ae5a-7c9b1d3f5e64',
  run: '1c7a4d2f-3e5b-4a7c-9b2d-4f6e8a0c2b31',
  userMessage: '2d8b5e3a-4f6c-4b8d-8c3e-5a7f9b1d3c42',
  assistantMessage: '3e9c6f4b-5a7d-4c9e-9d4f-6b8a0c2e4d53',
  chunk: '5abe8b6d-7c9f-4ebf-8f6b-8d0c2e4a6f75',
} as const;

export const NOW = '2026-10-10T09:00:00.000Z';

export const chunkSource: SourceSummary = {
  kind: 'chunk',
  id: ids.chunk,
  title: 'Sicily › Do › Hiking',
  destinationId: 'sicily',
  snippet: 'Inland, the Madonie and Nebrodi mountain parks offer forested ridges.',
  url: 'https://en.wikivoyage.org/w/index.php?title=Sicily&oldid=5320270',
};

export const poiSource: SourceSummary = {
  kind: 'poi',
  id: 'sicily-madonie-regional-natural-park',
  title: 'Madonie Regional Natural Park',
  destinationId: 'sicily',
  snippet: 'Mountainous reserve east of Palermo with charming villages and hiking trails.',
  url: 'https://en.wikivoyage.org/w/index.php?title=Sicily&oldid=5320270',
};

export const weatherSource: SourceSummary = {
  kind: 'weather',
  id: 'toolu_weather',
  title: 'Sicily climate in May',
  destinationId: 'sicily',
  snippet: 'May: 23 °C / 16.1 °C, 8 rain days',
  url: null,
};

export const budgetSource: SourceSummary = {
  kind: 'budget',
  id: 'toolu_budget',
  title: 'Budget estimate for Sicily',
  destinationId: 'sicily',
  snippet: 'No priced listings: total unknown',
  url: null,
};

export const weatherCall: ToolCallSummary = {
  callId: 'toolu_weather',
  name: 'get_seasonal_weather',
  input: { destinationId: 'sicily', month: 5 },
  ok: true,
  durationMs: 38,
  summary: 'May in Sicily: 23 °C / 16.1 °C, 8 rain days',
};

export const failedCall: ToolCallSummary = {
  callId: 'toolu_search',
  name: 'search_knowledge',
  input: { query: 'quiet trails', destinationId: 'sicily' },
  ok: false,
  durationMs: 5000,
  summary: 'Timed out after 5 s',
};

export function itineraryResponse(): AgentResponseOf<'itinerary'> {
  return {
    type: 'itinerary',
    message: 'Here is a quiet hiking plan.',
    brief: { ...EMPTY_TRIP_BRIEF, destinationId: 'sicily', month: 5, durationDays: 2 },
    itinerary: {
      destinationId: 'sicily',
      title: 'Two quiet days in Sicily',
      summary: 'Forest trails and hill villages.',
      month: 5,
      durationDays: 2,
      travelers: 2,
      days: [
        {
          day: 1,
          theme: 'Madonie mountains',
          items: [
            {
              slot: 'morning',
              title: 'Hike in the Madonie',
              poiId: 'sicily-madonie-regional-natural-park',
              description: 'Forested ridges and village-to-village trails.',
              justification: 'Matches your interest in hiking.',
              sourceRefs: [
                { kind: 'poi', id: 'sicily-madonie-regional-natural-park' },
                { kind: 'chunk', id: ids.chunk },
              ],
            },
          ],
        },
        {
          day: 2,
          theme: 'Rest day',
          items: [
            {
              slot: 'evening',
              title: 'Slow evening',
              poiId: null,
              description: 'Dinner in the village.',
              justification: 'Keeps the pace relaxed.',
              sourceRefs: [{ kind: 'chunk', id: ids.chunk }],
            },
          ],
        },
      ],
      budget: {
        level: 'mid',
        currency: 'unknown',
        total: null,
        perPerson: null,
        fromToolCallId: 'toolu_budget',
        notes: ['No Sleep listing in the article has a parseable price: value unknown.'],
      },
      weather: {
        month: 5,
        summary: 'Warm days around 23 °C, about 8 rainy days.',
        fromToolCallId: 'toolu_weather',
      },
      assumptions: ['2 travellers assumed.'],
      warnings: ['Trail signage varies: carry a GPS map.'],
    },
  };
}

export function clarificationResponse(questions: string[]): AgentResponseOf<'clarification'> {
  return {
    type: 'clarification',
    message: 'A couple of details first.',
    questions,
    brief: { ...EMPTY_TRIP_BRIEF, destinationId: 'sicily' },
  };
}

export function answerResponse(): AgentResponseOf<'answer'> {
  return {
    type: 'answer',
    message: 'The Madonie park has village-to-village hikes.',
    sourceRefs: [{ kind: 'chunk', id: ids.chunk }],
    brief: { ...EMPTY_TRIP_BRIEF, destinationId: 'sicily' },
  };
}

export function declineResponse(
  reason: AgentResponseOf<'decline'>['reason'],
): AgentResponseOf<'decline'> {
  return {
    type: 'decline',
    reason,
    message: 'I can only plan trips.',
    brief: EMPTY_TRIP_BRIEF,
  };
}

export function assistantMessage(
  response: AgentResponse = answerResponse(),
  overrides: Partial<AssistantMessage> = {},
): AssistantMessage {
  return {
    id: ids.assistantMessage,
    role: 'assistant',
    runId: ids.run,
    response,
    sources: [chunkSource, poiSource, weatherSource, budgetSource],
    toolCalls: [weatherCall, failedCall],
    createdAt: NOW,
    ...overrides,
  };
}

export function runStats(overrides: Partial<RunStats> = {}): RunStats {
  return {
    steps: 4,
    usage: { inputTokens: 12000, outputTokens: 1500, cacheReadTokens: 8000, cacheWriteTokens: 0 },
    costUsd: 0.0215,
    latencyMs: 15400,
    traceId: null,
    ...overrides,
  };
}

export function runFinished(overrides: Partial<RunFinishedEvent> = {}): RunFinishedEvent {
  return { type: 'run.finished', runId: ids.run, ...runStats(), ...overrides };
}

export function conversationSummary(
  overrides: Partial<ConversationSummary> = {},
): ConversationSummary {
  return {
    id: ids.conversation,
    title: 'Quiet hiking in Sicily',
    createdAt: NOW,
    updatedAt: NOW,
    ...overrides,
  };
}

export function conversationDetail(
  overrides: Partial<GetConversationResponse> = {},
): GetConversationResponse {
  return {
    ...conversationSummary(),
    brief: EMPTY_TRIP_BRIEF,
    messages: [
      {
        id: ids.userMessage,
        role: 'user',
        text: 'Hiking in Sicily?',
        createdAt: NOW,
      },
      assistantMessage(),
    ],
    ...overrides,
  };
}
