import { describe, expect, it } from 'vitest';
import { ApiError, type ApiFailureKind } from '../lib/api';
import { describeFailure } from './useApiStatus';

describe('describeFailure', () => {
  it.each<[ApiFailureKind, number | undefined, string]>([
    ['timeout', undefined, 'timed out'],
    ['network', undefined, 'unreachable'],
    ['http', 502, 'HTTP 502'],
    ['http', undefined, 'server error'],
    ['invalid-response', 200, 'unexpected response'],
    ['aborted', undefined, 'cancelled'],
  ])('describes a %s failure (status %s) as "%s"', (kind, status, expected) => {
    expect(describeFailure(new ApiError(kind, 'failure', { status }))).toBe(expected);
  });

  it('does not leak the message of an unknown error', () => {
    expect(describeFailure(new Error('secret stack detail'))).toBe('unexpected error');
  });
});
