import { describe, expect, expectTypeOf, it } from 'vitest';
import { ApiErrorCode, ApiErrorCodeSchema, ApiErrorResponseSchema } from './index.js';

describe('ApiErrorCode', () => {
  it('lists exactly the error codes the API can return', () => {
    expect(ApiErrorCodeSchema.options).toEqual([
      'VALIDATION_ERROR',
      'NOT_FOUND',
      'RATE_LIMITED',
      'BUDGET_EXCEEDED',
      'LLM_TIMEOUT',
      'PROVIDER_UNAVAILABLE',
      'INVALID_OUTPUT',
      'INTERNAL_ERROR',
    ]);
  });

  it('exposes a const object whose keys equal their values', () => {
    for (const [key, value] of Object.entries(ApiErrorCode)) {
      expect(key).toBe(value);
    }
    expectTypeOf(ApiErrorCode.NOT_FOUND).toEqualTypeOf<'NOT_FOUND'>();
  });

  it('rejects unknown codes', () => {
    expect(ApiErrorCodeSchema.safeParse('TEAPOT').success).toBe(false);
  });
});

describe('ApiErrorResponseSchema', () => {
  it('accepts an envelope with a request id', () => {
    const body = {
      error: { code: 'NOT_FOUND', message: 'Route not found.', requestId: 'req-1' },
    };
    expect(ApiErrorResponseSchema.parse(body)).toEqual(body);
  });

  it('accepts an envelope without a request id', () => {
    const body = { error: { code: 'INTERNAL_ERROR', message: 'Something went wrong.' } };
    expect(ApiErrorResponseSchema.safeParse(body).success).toBe(true);
  });

  it.each([
    ['missing error object', {}],
    ['unknown code', { error: { code: 'NOPE', message: 'x' } }],
    ['empty message', { error: { code: 'NOT_FOUND', message: '' } }],
    ['empty request id', { error: { code: 'NOT_FOUND', message: 'x', requestId: '' } }],
  ])('rejects an envelope with %s', (_label, body) => {
    expect(ApiErrorResponseSchema.safeParse(body).success).toBe(false);
  });

  it('strips unknown keys such as stack traces', () => {
    const parsed = ApiErrorResponseSchema.parse({
      error: { code: 'INTERNAL_ERROR', message: 'Something went wrong.', stack: 'at x' },
    });
    expect(parsed.error).not.toHaveProperty('stack');
  });
});
