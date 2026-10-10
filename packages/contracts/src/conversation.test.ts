import { describe, expect, it } from 'vitest';
import { EMPTY_TRIP_BRIEF } from './agent.js';
import {
  AgentEventSchema,
  FeedbackRequestSchema,
  MAX_USER_MESSAGE_CHARS,
  SendMessageRequestSchema,
} from './conversation.js';

const runId = '6f1c2a54-3a5e-4f61-9d55-6c3f1b0e2a11';
const messageId = '0b8e7c1d-2f4a-4c3b-8e9d-1a2b3c4d5e6f';

describe('SendMessageRequestSchema', () => {
  it('trims and accepts a normal message', () => {
    expect(SendMessageRequestSchema.parse({ text: '  A week in Sicily  ' })).toEqual({
      text: 'A week in Sicily',
    });
  });

  it('rejects blank and oversized messages', () => {
    expect(SendMessageRequestSchema.safeParse({ text: '   ' }).success).toBe(false);
    const tooLong = 'x'.repeat(MAX_USER_MESSAGE_CHARS + 1);
    expect(SendMessageRequestSchema.safeParse({ text: tooLong }).success).toBe(false);
  });
});

describe('FeedbackRequestSchema', () => {
  it('accepts thumbs up and down only', () => {
    expect(FeedbackRequestSchema.safeParse({ rating: 1, comment: null }).success).toBe(true);
    expect(FeedbackRequestSchema.safeParse({ rating: -1, comment: 'meh' }).success).toBe(true);
    expect(FeedbackRequestSchema.safeParse({ rating: 0, comment: null }).success).toBe(false);
  });
});

describe('AgentEventSchema', () => {
  it('parses a response event carrying a validated agent response', () => {
    const event = AgentEventSchema.parse({
      type: 'response',
      runId,
      message: {
        id: messageId,
        role: 'assistant',
        runId,
        response: {
          type: 'answer',
          message: 'May is mild.',
          sourceRefs: [],
          brief: EMPTY_TRIP_BRIEF,
        },
        sources: [],
        toolCalls: [],
        createdAt: '2026-10-10T12:00:00.000Z',
      },
    });
    expect(event.type).toBe('response');
  });

  it('parses an error event without a run', () => {
    const event = AgentEventSchema.parse({
      type: 'error',
      runId: null,
      error: { code: 'BUDGET_EXCEEDED', message: 'The daily demo budget is used up.' },
    });
    expect(event.type).toBe('error');
  });

  it('rejects an unknown event type', () => {
    expect(AgentEventSchema.safeParse({ type: 'token', runId }).success).toBe(false);
  });
});
