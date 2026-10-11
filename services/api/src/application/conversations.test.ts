import {
  EMPTY_TRIP_BRIEF,
  GetConversationResponseSchema,
  ListConversationsResponseSchema,
} from '@wanderly/contracts';
import { beforeEach, describe, expect, it } from 'vitest';
import {
  ANSWER,
  InMemoryStore,
  SESSION_A,
  SESSION_B,
  SOURCES,
  TOOL_CALLS,
  manualClock,
  sequentialIds,
} from '../../test/application-fakes.js';
import { NotFoundError } from '../domain/errors.js';
import {
  MAX_LISTED_CONVERSATIONS,
  createCreateConversation,
  createGetConversation,
  createListConversations,
} from './conversations.js';
import type { RunRecord } from './ports/runs.js';

let store: InMemoryStore;
let clock: ReturnType<typeof manualClock>;
let ids: ReturnType<typeof sequentialIds>;

beforeEach(() => {
  store = new InMemoryStore();
  clock = manualClock('2026-10-10T09:00:00.000Z');
  ids = sequentialIds();
});

const deps = () => ({ conversations: store.conversationRepository, ids, clock });

describe('CreateConversation', () => {
  it('creates an untitled conversation with an empty brief for the session', async () => {
    const summary = await createCreateConversation(deps()).execute({ sessionId: SESSION_A });

    expect(summary).toEqual({
      id: ids.issued[0],
      title: null,
      createdAt: '2026-10-10T09:00:00.000Z',
      updatedAt: '2026-10-10T09:00:00.000Z',
    });
    expect(store.conversations.get(summary.id)).toMatchObject({
      sessionId: SESSION_A,
      brief: EMPTY_TRIP_BRIEF,
    });
  });
});

describe('ListConversations', () => {
  it("lists only the session's conversations, most recently updated first", async () => {
    const create = createCreateConversation(deps());
    const older = await create.execute({ sessionId: SESSION_A });
    clock.advance(60_000);
    const newer = await create.execute({ sessionId: SESSION_A });
    await create.execute({ sessionId: SESSION_B });

    const result = await createListConversations(deps()).execute({ sessionId: SESSION_A });

    expect(ListConversationsResponseSchema.parse(result)).toEqual({
      conversations: [newer, older],
    });
  });

  it(`returns at most ${MAX_LISTED_CONVERSATIONS} conversations`, async () => {
    const create = createCreateConversation(deps());
    for (let index = 0; index < MAX_LISTED_CONVERSATIONS + 3; index += 1) {
      await create.execute({ sessionId: SESSION_A });
    }

    const result = await createListConversations(deps()).execute({ sessionId: SESSION_A });

    expect(result.conversations).toHaveLength(MAX_LISTED_CONVERSATIONS);
  });

  it('returns an empty list for a new session', async () => {
    await expect(
      createListConversations(deps()).execute({ sessionId: SESSION_B }),
    ).resolves.toEqual({ conversations: [] });
  });
});

describe('GetConversation', () => {
  async function conversationWithOneTurn() {
    const { id } = await createCreateConversation(deps()).execute({ sessionId: SESSION_A });
    const userMessageId = ids.newId();
    const assistantMessageId = ids.newId();
    await store.conversationRepository.appendMessages(id, [
      {
        id: userMessageId,
        message: { role: 'user', content: [{ type: 'text', text: 'Sicily in May?' }] },
        provider: null,
        model: null,
        createdAt: new Date('2026-10-10T09:01:00.000Z'),
      },
      {
        id: assistantMessageId,
        message: { role: 'assistant', content: [{ type: 'text', text: '…' }] },
        provider: 'fake',
        model: 'fake-model',
        createdAt: new Date('2026-10-10T09:01:05.000Z'),
      },
    ]);
    await store.conversationRepository.updateAfterTurn(id, {
      brief: ANSWER.brief,
      titleIfUnset: 'Sicily in May?',
      updatedAt: new Date('2026-10-10T09:01:05.000Z'),
    });
    const run: RunRecord = {
      id: ids.newId(),
      conversationId: id,
      traceId: 'trace-1',
      model: 'fake-model',
      promptVersion: 'agent-v1-test',
      status: 'ok',
      responseType: 'answer',
      errorCode: null,
      failureReason: null,
      steps: 2,
      repairs: 0,
      toolCallCount: 2,
      toolErrorCount: 1,
      usage: { inputTokens: 1, outputTokens: 1, cacheReadTokens: 0, cacheWriteTokens: 0 },
      costUsd: 0.001,
      latencyMs: 5_000,
      validFirstTry: true,
      citationsOk: true,
      userText: 'Sicily in May?',
      userMessageId,
      assistantMessageId,
      response: ANSWER,
      sources: SOURCES,
      toolCalls: TOOL_CALLS,
      createdAt: new Date('2026-10-10T09:01:05.000Z'),
    };
    await store.runRepository.save(run);
    // A failed run is not part of the transcript.
    await store.runRepository.save({
      ...run,
      id: ids.newId(),
      status: 'error',
      errorCode: 'LLM_TIMEOUT',
      response: null,
      userMessageId: null,
    });
    return { id, run, userMessageId, assistantMessageId };
  }

  it('maps the completed turns to user and assistant messages', async () => {
    const { id, run, userMessageId, assistantMessageId } = await conversationWithOneTurn();

    const detail = await createGetConversation(deps()).execute({
      sessionId: SESSION_A,
      conversationId: id,
    });

    expect(GetConversationResponseSchema.parse(detail)).toEqual({
      id,
      title: 'Sicily in May?',
      createdAt: '2026-10-10T09:00:00.000Z',
      updatedAt: '2026-10-10T09:01:05.000Z',
      brief: ANSWER.brief,
      messages: [
        {
          id: userMessageId,
          role: 'user',
          text: 'Sicily in May?',
          createdAt: '2026-10-10T09:01:00.000Z',
        },
        {
          id: assistantMessageId,
          role: 'assistant',
          runId: run.id,
          response: ANSWER,
          sources: SOURCES,
          toolCalls: TOOL_CALLS,
          createdAt: '2026-10-10T09:01:05.000Z',
          run: {
            steps: 2,
            usage: { inputTokens: 1, outputTokens: 1, cacheReadTokens: 0, cacheWriteTokens: 0 },
            costUsd: 0.001,
            latencyMs: 5_000,
            traceId: 'trace-1',
          },
          feedback: null,
        },
      ],
    });
  });

  it("includes the session's rating of each answer", async () => {
    const { id, run } = await conversationWithOneTurn();
    await store.feedbackRepository.upsert({
      runId: run.id,
      rating: -1,
      comment: null,
      createdAt: new Date('2026-10-10T09:02:00.000Z'),
    });

    const detail = await createGetConversation(deps()).execute({
      sessionId: SESSION_A,
      conversationId: id,
    });

    expect(detail.messages[1]).toMatchObject({ role: 'assistant', feedback: { rating: -1 } });
  });

  it('answers NotFound for a conversation of another session', async () => {
    const { id } = await conversationWithOneTurn();

    await expect(
      createGetConversation(deps()).execute({ sessionId: SESSION_B, conversationId: id }),
    ).rejects.toBeInstanceOf(NotFoundError);
  });

  it('answers NotFound for an unknown conversation', async () => {
    await expect(
      createGetConversation(deps()).execute({
        sessionId: SESSION_A,
        conversationId: '00000000-0000-4000-8000-0000000000ff',
      }),
    ).rejects.toMatchObject({ code: 'NOT_FOUND', resource: 'conversation' });
  });
});
