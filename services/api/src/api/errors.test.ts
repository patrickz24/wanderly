import { ApiErrorResponseSchema } from '@wanderly/contracts';
import { describe, expect, it } from 'vitest';
import {
  BudgetExceededError,
  InvalidOutputError,
  LlmTimeoutError,
  NotFoundError,
  ProviderUnavailableError,
} from '../domain/errors.js';
import { HttpError, INTERNAL_ERROR_MESSAGE, mapError } from './errors.js';

const REQUEST_ID = 'req-123';

const withStatus = (statusCode: unknown, message = 'Framework says no') =>
  Object.assign(new Error(message), { statusCode });

describe('mapError', () => {
  it.each([
    [new NotFoundError('Conversation', 'c-1'), 404, 'NOT_FOUND', 'info'],
    [new BudgetExceededError(2.1, 2), 503, 'BUDGET_EXCEEDED', 'warn'],
    [new LlmTimeoutError(45_000), 504, 'LLM_TIMEOUT', 'warn'],
    [
      new ProviderUnavailableError('anthropic', { status: 529 }),
      503,
      'PROVIDER_UNAVAILABLE',
      'warn',
    ],
    [new InvalidOutputError(['days: expected 3']), 502, 'INVALID_OUTPUT', 'warn'],
  ])('maps %s to %i %s with a curated message', (error, statusCode, code, logLevel) => {
    const mapped = mapError(error, REQUEST_ID);

    expect(mapped.statusCode).toBe(statusCode);
    expect(mapped.logLevel).toBe(logLevel);
    expect(mapped.body.error.code).toBe(code);
    expect(mapped.body.error.requestId).toBe(REQUEST_ID);
    // The internal domain message (ids, amounts, issues) never reaches the client.
    expect(mapped.body.error.message).not.toBe(error.message);
    expect(ApiErrorResponseSchema.safeParse(mapped.body).success).toBe(true);
  });

  it('passes HttpError through, its message being public by construction', () => {
    const mapped = mapError(new HttpError(429, 'RATE_LIMITED', 'Slow down.'), REQUEST_ID);
    expect(mapped).toEqual({
      statusCode: 429,
      logLevel: 'info',
      body: { error: { code: 'RATE_LIMITED', message: 'Slow down.', requestId: REQUEST_ID } },
    });
  });

  it('logs a 5xx HttpError as an error', () => {
    expect(mapError(new HttpError(500, 'INTERNAL_ERROR', 'Oops.'), REQUEST_ID).logLevel).toBe(
      'error',
    );
  });

  it.each([
    [400, 'VALIDATION_ERROR'],
    [413, 'VALIDATION_ERROR'],
    [415, 'VALIDATION_ERROR'],
    [404, 'NOT_FOUND'],
    [429, 'RATE_LIMITED'],
  ])('keeps framework 4xx status %i as %s with its message', (statusCode, code) => {
    const mapped = mapError(withStatus(statusCode), REQUEST_ID);
    expect(mapped.statusCode).toBe(statusCode);
    expect(mapped.logLevel).toBe('info');
    expect(mapped.body.error).toEqual({
      code,
      message: 'Framework says no',
      requestId: REQUEST_ID,
    });
  });

  it('falls back to a generic message for an empty 4xx message', () => {
    expect(mapError(withStatus(400, '  '), REQUEST_ID).body.error.message).toBe('Invalid request.');
  });

  it('truncates very long 4xx messages', () => {
    const message = mapError(withStatus(400, 'x'.repeat(1_000)), REQUEST_ID).body.error.message;
    expect(message).toHaveLength(300);
    expect(message.endsWith('…')).toBe(true);
  });

  it.each([
    ['an unexpected Error', new Error('connect ECONNREFUSED 10.0.0.5:5432 password=hunter2')],
    ['a 5xx framework error', withStatus(503, 'internal detail')],
    ['a non-numeric status', withStatus('400', 'internal detail')],
    ['a thrown string', 'boom'],
    ['null', null],
  ])('hides %s behind a generic 500', (_label, error) => {
    const mapped = mapError(error, REQUEST_ID);
    expect(mapped).toEqual({
      statusCode: 500,
      logLevel: 'error',
      body: {
        error: { code: 'INTERNAL_ERROR', message: INTERNAL_ERROR_MESSAGE, requestId: REQUEST_ID },
      },
    });
  });
});
