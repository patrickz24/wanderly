import { EMPTY_TRIP_BRIEF } from '@wanderly/contracts';
import { beforeEach, describe, expect, it } from 'vitest';
import {
  InMemoryStore,
  SESSION_A,
  SESSION_B,
  manualClock,
  recordingTracer,
} from '../../test/application-fakes.js';
import { NotFoundError } from '../domain/errors.js';
import type { RunRecord } from './ports/runs.js';
import { USER_FEEDBACK_SCORE, createSubmitFeedback } from './submit-feedback.js';

const CONVERSATION_ID = 'c0000000-0000-4000-8000-000000000001';
const RUN_ID = 'r0000000-0000-4000-8000-000000000001';

let store: InMemoryStore;
let tracer: ReturnType<typeof recordingTracer>;
const clock = manualClock('2026-10-10T12:00:00.000Z');

function run(overrides: Partial<RunRecord> = {}): RunRecord {
  return {
    id: RUN_ID,
    conversationId: CONVERSATION_ID,
    traceId: 'trace-77',
    model: 'fake-model',
    promptVersion: 'agent-v1-test',
    status: 'error',
    responseType: null,
    errorCode: 'LLM_TIMEOUT',
    failureReason: null,
    steps: 1,
    repairs: 0,
    toolCallCount: 0,
    toolErrorCount: 0,
    usage: { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 },
    costUsd: 0,
    latencyMs: 10,
    validFirstTry: null,
    citationsOk: null,
    userText: 'hello',
    userMessageId: null,
    assistantMessageId: null,
    response: null,
    sources: [],
    toolCalls: [],
    createdAt: new Date('2026-10-10T11:00:00.000Z'),
    ...overrides,
  };
}

beforeEach(async () => {
  store = new InMemoryStore();
  tracer = recordingTracer();
  await store.conversationRepository.create({
    id: CONVERSATION_ID,
    sessionId: SESSION_A,
    brief: EMPTY_TRIP_BRIEF,
    now: new Date('2026-10-10T10:00:00.000Z'),
  });
});

const submitFeedback = () =>
  createSubmitFeedback({
    runs: store.runRepository,
    feedback: store.feedbackRepository,
    tracer,
    clock,
  });

describe('SubmitFeedback', () => {
  it('stores the rating and scores the run trace', async () => {
    await store.runRepository.save(run());

    await submitFeedback().execute({
      sessionId: SESSION_A,
      runId: RUN_ID,
      rating: -1,
      comment: 'The second day is too packed.',
    });

    expect(store.feedback.get(RUN_ID)).toEqual({
      runId: RUN_ID,
      rating: -1,
      comment: 'The second day is too packed.',
      createdAt: new Date('2026-10-10T12:00:00.000Z'),
    });
    expect(tracer.traceScores).toEqual([
      {
        traceId: 'trace-77',
        name: USER_FEEDBACK_SCORE,
        value: -1,
        comment: 'The second day is too packed.',
      },
    ]);
  });

  it('replaces a previous rating and treats an empty comment as none', async () => {
    await store.runRepository.save(run());
    await submitFeedback().execute({
      sessionId: SESSION_A,
      runId: RUN_ID,
      rating: -1,
      comment: 'meh',
    });

    await submitFeedback().execute({ sessionId: SESSION_A, runId: RUN_ID, rating: 1, comment: '' });

    expect(store.feedback.get(RUN_ID)).toMatchObject({ rating: 1, comment: null });
    expect(tracer.traceScores.at(-1)).toEqual({
      traceId: 'trace-77',
      name: USER_FEEDBACK_SCORE,
      value: 1,
    });
  });

  it('stores the rating without a score when the run was not traced', async () => {
    await store.runRepository.save(run({ traceId: null }));

    await submitFeedback().execute({
      sessionId: SESSION_A,
      runId: RUN_ID,
      rating: 1,
      comment: null,
    });

    expect(store.feedback.get(RUN_ID)?.rating).toBe(1);
    expect(tracer.traceScores).toEqual([]);
  });

  it("answers NotFound for another session's run, without storing anything", async () => {
    await store.runRepository.save(run());

    await expect(
      submitFeedback().execute({ sessionId: SESSION_B, runId: RUN_ID, rating: 1, comment: null }),
    ).rejects.toBeInstanceOf(NotFoundError);
    expect(store.feedback.size).toBe(0);
    expect(tracer.traceScores).toEqual([]);
  });

  it('answers NotFound for an unknown run', async () => {
    await expect(
      submitFeedback().execute({ sessionId: SESSION_A, runId: RUN_ID, rating: 1, comment: null }),
    ).rejects.toMatchObject({ code: 'NOT_FOUND', resource: 'run' });
  });
});
