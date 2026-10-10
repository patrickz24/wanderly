import {
  AgentEventSchema,
  GetConversationResponseSchema,
  RunFinishedEventSchema,
  type AgentEvent,
} from '@wanderly/contracts';
import { describe, expect, it } from 'vitest';
import { numberSources, sourceKey } from '../lib/sources';
import { isDemoMode } from './demoMode';
import { createDemoTransport } from './demoTransport';
import { DEMO_CONVERSATIONS, DEMO_IDS, DEMO_REPLAY } from './fixtures';

const assistantMessages = DEMO_CONVERSATIONS.flatMap((conversation) =>
  conversation.messages.filter((message) => message.role === 'assistant'),
);

describe('demo fixtures', () => {
  it.each(DEMO_CONVERSATIONS.map((c) => [c.title, c] as const))(
    '"%s" satisfies the API contract',
    (_title, conversation) => {
      expect(() => GetConversationResponseSchema.parse(conversation)).not.toThrow();
    },
  );

  it('covers the itinerary, clarification, answer and decline types', () => {
    const types = new Set(assistantMessages.map((message) => message.response.type));
    expect([...types].sort()).toEqual(['answer', 'clarification', 'decline', 'itinerary']);
  });

  it('only cites sources the message lists (grounded like a real run)', () => {
    for (const message of assistantMessages) {
      const listed = numberSources(message.sources);
      const { response } = message;
      const refs =
        response.type === 'itinerary'
          ? [
              ...response.itinerary.days.flatMap((day) => day.items.flatMap((i) => i.sourceRefs)),
              ...(response.itinerary.budget
                ? [{ kind: 'budget' as const, id: response.itinerary.budget.fromToolCallId }]
                : []),
              ...(response.itinerary.weather
                ? [{ kind: 'weather' as const, id: response.itinerary.weather.fromToolCallId }]
                : []),
            ]
          : response.type === 'answer'
            ? response.sourceRefs
            : [];
      for (const ref of refs) {
        expect(listed.has(sourceKey(ref)), `${message.id} cites ${sourceKey(ref)}`).toBe(true);
      }
    }
  });

  it('invents no prices: without meal prices in the corpus, the budget has no total', () => {
    const itinerary = assistantMessages.find((m) => m.response.type === 'itinerary');
    expect(
      itinerary?.response.type === 'itinerary' && itinerary.response.itinerary.budget,
    ).toMatchObject({ total: null, perPerson: null });
  });

  it('contains no made-up measurements: no run statistics, tool durations left at 0', () => {
    for (const message of assistantMessages) {
      expect(message.run, message.runId).toBeUndefined();
      expect(message.toolCalls.every((call) => call.durationMs === 0)).toBe(true);
    }
    expect(DEMO_REPLAY.toolCalls.every((call) => call.durationMs === 0)).toBe(true);
  });
});

describe('createDemoTransport', () => {
  it('lists and loads the sample trips', async () => {
    const transport = createDemoTransport({ speed: 0 });

    const summaries = await transport.listConversations();
    expect(summaries.map((s) => s.id)).toEqual([DEMO_IDS.hikingTrip, DEMO_IDS.coastTrip]);

    const conversation = await transport.getConversation(DEMO_IDS.hikingTrip);
    expect(conversation.messages).toHaveLength(6);
  });

  it('remembers a rating until reload', async () => {
    const transport = createDemoTransport({ speed: 0 });

    await transport.postFeedback(DEMO_IDS.runItinerary, { rating: 1, comment: null });

    const conversation = await transport.getConversation(DEMO_IDS.hikingTrip);
    const rated = conversation.messages.find(
      (message) => message.role === 'assistant' && message.runId === DEMO_IDS.runItinerary,
    );
    expect(rated).toMatchObject({ feedback: { rating: 1 } });
  });

  it('answers NOT_FOUND for an unknown trip', async () => {
    const transport = createDemoTransport({ speed: 0 });
    await expect(transport.getConversation('nope')).rejects.toMatchObject({ code: 'NOT_FOUND' });
  });

  it('replays a contract-valid run and stores it in the conversation', async () => {
    const transport = createDemoTransport({ speed: 0 });
    const { id } = await transport.createConversation();
    const events: AgentEvent[] = [];

    await transport.sendMessage(id, 'Any hikes?', {
      signal: new AbortController().signal,
      onEvent: (event) => events.push(event),
    });

    for (const event of events) {
      expect(() => AgentEventSchema.parse(event)).not.toThrow();
    }
    expect(events.map((e) => e.type)).toEqual([
      'run.started',
      ...DEMO_REPLAY.toolCalls.flatMap(() => ['tool.started', 'tool.finished']),
      'response',
      'run.finished',
    ]);
    // The event needs figures; they are zeros because nothing was measured.
    expect(RunFinishedEventSchema.parse(events.at(-1))).toMatchObject({
      costUsd: 0,
      latencyMs: 0,
      usage: { inputTokens: 0, outputTokens: 0 },
    });

    const conversation = await transport.getConversation(id);
    expect(conversation.title).toBe('Any hikes?');
    expect(conversation.messages.map((m) => m.role)).toEqual(['user', 'assistant']);
  });

  it('stops replaying when aborted', async () => {
    const transport = createDemoTransport({ speed: 1 });
    const { id } = await transport.createConversation();
    const controller = new AbortController();
    const events: AgentEvent[] = [];

    const pending = transport.sendMessage(id, 'Any hikes?', {
      signal: controller.signal,
      onEvent: (event) => events.push(event),
    });
    controller.abort();

    await expect(pending).rejects.toMatchObject({ kind: 'aborted' });
    expect(events).toEqual([]);
  });
});

describe('isDemoMode', () => {
  it.each([
    ['?demo=1', true],
    ['?foo=bar&demo=1', true],
    ['', false],
    ['?demo=0', false],
    ['?demo=true', false],
  ])('%j → %s', (search, expected) => {
    expect(isDemoMode(search)).toBe(expected);
  });
});

describe('demo replay sources', () => {
  it('cites only the sources it lists', () => {
    const listed = new Set(DEMO_REPLAY.sources.map(sourceKey));
    expect(listed.size).toBe(DEMO_REPLAY.sources.length);
  });
});
