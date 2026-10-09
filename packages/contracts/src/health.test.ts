import { describe, expect, expectTypeOf, it } from 'vitest';
import {
  HealthResponseSchema,
  ReadyResponseSchema,
  type HealthResponse,
  type ReadyResponse,
} from './index.js';

describe('HealthResponseSchema', () => {
  it('accepts the liveness payload', () => {
    expect(HealthResponseSchema.parse({ status: 'ok' })).toEqual({ status: 'ok' });
    expectTypeOf<HealthResponse>().toEqualTypeOf<{ status: 'ok' }>();
  });

  it('rejects any other status', () => {
    expect(HealthResponseSchema.safeParse({ status: 'down' }).success).toBe(false);
  });
});

describe('ReadyResponseSchema', () => {
  it('accepts a passing report', () => {
    const body: ReadyResponse = {
      status: 'pass',
      checks: {
        database: { status: 'pass', durationMs: 3 },
        migrations: { status: 'pass', durationMs: 4.5 },
      },
    };
    expect(ReadyResponseSchema.parse(body)).toEqual(body);
  });

  it('accepts a failing report with per-check output', () => {
    const body = {
      status: 'fail',
      checks: {
        database: { status: 'pass', durationMs: 2 },
        migrations: { status: 'fail', durationMs: 2, output: '1 pending migration(s)' },
      },
    };
    expect(ReadyResponseSchema.safeParse(body).success).toBe(true);
  });

  it.each([
    ['unknown status', { status: 'ready', checks: {} }],
    ['negative duration', { status: 'pass', checks: { db: { status: 'pass', durationMs: -1 } } }],
    ['bad check status', { status: 'fail', checks: { db: { status: 'warn', durationMs: 1 } } }],
    ['empty check name', { status: 'pass', checks: { '': { status: 'pass', durationMs: 1 } } }],
  ])('rejects a report with %s', (_label, body) => {
    expect(ReadyResponseSchema.safeParse(body).success).toBe(false);
  });
});
