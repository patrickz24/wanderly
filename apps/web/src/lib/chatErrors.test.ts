import { ApiErrorCodeSchema } from '@wanderly/contracts';
import { describe, expect, it } from 'vitest';
import { ApiError } from './api';
import { describeChatError, describeWait, toChatError, type ChatErrorReason } from './chatErrors';

describe('toChatError', () => {
  it('uses the API error code when the response carried one', () => {
    const error = new ApiError('http', 'Daily budget exceeded.', {
      status: 503,
      code: 'BUDGET_EXCEEDED',
    });
    expect(toChatError(error)).toEqual({ reason: 'BUDGET_EXCEEDED', retryAfterMs: null });
  });

  it('keeps the Retry-After delay of a rate-limited request', () => {
    const error = new ApiError('http', 'Too many requests.', {
      status: 429,
      code: 'RATE_LIMITED',
      retryAfterMs: 30_000,
    });
    expect(toChatError(error)).toEqual({ reason: 'RATE_LIMITED', retryAfterMs: 30_000 });
  });

  it.each<[number, ChatErrorReason]>([
    [429, 'RATE_LIMITED'],
    [404, 'NOT_FOUND'],
    [502, 'SERVICE_UNAVAILABLE'],
    [503, 'SERVICE_UNAVAILABLE'],
    [504, 'SERVICE_UNAVAILABLE'],
    [500, 'INTERNAL_ERROR'],
    [418, 'INTERNAL_ERROR'],
  ])('classifies HTTP %i without an envelope as %s', (status, reason) => {
    expect(toChatError(new ApiError('http', 'x', { status })).reason).toBe(reason);
  });

  it.each<[ApiError['kind'], ChatErrorReason]>([
    ['network', 'NETWORK'],
    ['timeout', 'STREAM_TIMEOUT'],
    ['invalid-response', 'BAD_RESPONSE'],
  ])('classifies a %s failure as %s', (kind, reason) => {
    expect(toChatError(new ApiError(kind, 'x')).reason).toBe(reason);
  });

  it('treats anything else as an internal error', () => {
    expect(toChatError(new Error('boom'))).toEqual({
      reason: 'INTERNAL_ERROR',
      retryAfterMs: null,
    });
    expect(toChatError('string thrown')).toEqual({ reason: 'INTERNAL_ERROR', retryAfterMs: null });
  });
});

describe('describeChatError', () => {
  it.each(ApiErrorCodeSchema.options)('has a friendly message for %s', (code) => {
    const { title, message } = describeChatError({ reason: code, retryAfterMs: null });
    expect(title).not.toBe('');
    expect(message).not.toBe('');
    expect(message).not.toContain(code);
  });

  it('tells how long to wait when the server said so', () => {
    expect(describeChatError({ reason: 'RATE_LIMITED', retryAfterMs: 42_000 }).message).toBe(
      'Please wait about 42 seconds before sending another message.',
    );
  });

  it('falls back to "a minute" without Retry-After', () => {
    expect(describeChatError({ reason: 'RATE_LIMITED', retryAfterMs: null }).message).toBe(
      'Please wait a minute before sending another message.',
    );
  });

  it.each<[ChatErrorReason, string]>([
    ['BUDGET_EXCEEDED', "The demo's daily budget is used up. Back tomorrow!"],
    ['LLM_TIMEOUT', 'The assistant took too long to answer. Please try again.'],
    [
      'PROVIDER_UNAVAILABLE',
      'The AI service is temporarily unavailable. Please try again in a few minutes.',
    ],
    ['INVALID_OUTPUT', "I couldn't produce a valid plan for this request. Try rephrasing it."],
    ['VALIDATION_ERROR', 'Messages must not be empty and must stay under 2,000 characters.'],
    [
      'NOT_FOUND',
      'This trip is no longer available. Conversations are deleted after 30 days. Start a new trip.',
    ],
    ['NETWORK', "Wanderly can't be reached right now. Check your connection and try again."],
  ])('maps %s to its message', (reason, message) => {
    expect(describeChatError({ reason, retryAfterMs: null }).message).toBe(message);
  });
});

describe('describeWait', () => {
  it.each([
    [0, 'about 1 second'],
    [1, 'about 1 second'],
    [1_000, 'about 1 second'],
    [1_001, 'about 2 seconds'],
    [89_000, 'about 89 seconds'],
    [90_000, 'about 2 minutes'],
    [600_000, 'about 10 minutes'],
  ])('describes %i ms as "%s"', (ms, text) => {
    expect(describeWait(ms)).toBe(text);
  });
});
