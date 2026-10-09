import { describe, expect, it } from 'vitest';
import { REDACTED, REDACT_PATHS, buildLoggerOptions } from './logger.js';

describe('buildLoggerOptions', () => {
  it('always redacts credentials', () => {
    const options = buildLoggerOptions('info', 'production');
    expect(options.level).toBe('info');
    expect(options.redact).toEqual({ paths: REDACT_PATHS, censor: REDACTED });
    expect(REDACT_PATHS).toEqual(
      expect.arrayContaining(['req.headers.authorization', 'req.headers.cookie', '*.apiKey']),
    );
  });

  it('writes raw JSON lines outside development', () => {
    expect(buildLoggerOptions('warn', 'production')).not.toHaveProperty('transport');
    expect(buildLoggerOptions('warn', 'test')).not.toHaveProperty('transport');
  });

  it('pretty-prints in development', () => {
    expect(buildLoggerOptions('debug', 'development').transport).toMatchObject({
      target: 'pino-pretty',
    });
  });

  it('uses an explicit destination when given, even in development', () => {
    const destination = { write: () => undefined };
    const options = buildLoggerOptions('info', 'development', destination);
    expect(options.stream).toBe(destination);
    expect(options).not.toHaveProperty('transport');
  });
});
