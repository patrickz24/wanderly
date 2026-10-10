import { describe, expect, it } from 'vitest';
import { probeLogLevel, toReadyResponse } from './health.js';

describe('probeLogLevel', () => {
  it.each([
    ['trace', 'warn'],
    ['debug', 'warn'],
    ['info', 'warn'],
    ['warn', 'warn'],
    ['error', 'error'],
    ['fatal', 'fatal'],
    ['silent', 'silent'],
  ] as const)('maps a configured %s level to %s', (configured, expected) => {
    expect(probeLogLevel(configured)).toBe(expected);
  });
});

describe('toReadyResponse', () => {
  it('drops internal detail and omits absent output', () => {
    expect(
      toReadyResponse({
        status: 'fail',
        checks: {
          database: { status: 'pass', durationMs: 1 },
          migrations: { status: 'fail', durationMs: 2, output: 'x', detail: new Error('secret') },
        },
      }),
    ).toEqual({
      status: 'fail',
      checks: {
        database: { status: 'pass', durationMs: 1 },
        migrations: { status: 'fail', durationMs: 2, output: 'x' },
      },
    });
  });
});
