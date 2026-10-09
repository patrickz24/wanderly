import type { FastifyServerOptions } from 'fastify';
import type { LogLevel, NodeEnv } from '../config.js';

type LoggerOptions = Exclude<NonNullable<FastifyServerOptions['logger']>, boolean>;

/** Minimal writable destination (stdout by default; a memory stream in tests). */
export interface LogDestination {
  write(line: string): void;
}

export const REDACTED = '[redacted]';

/**
 * Credentials must never reach the logs, wherever they appear: request or
 * response headers, or ad-hoc objects passed to the logger.
 */
export const REDACT_PATHS = [
  'req.headers.authorization',
  'req.headers.cookie',
  'req.headers["proxy-authorization"]',
  'req.headers["x-api-key"]',
  'res.headers["set-cookie"]',
  'headers.authorization',
  'headers.cookie',
  'headers["proxy-authorization"]',
  'headers["x-api-key"]',
  'headers["set-cookie"]',
  '*.authorization',
  '*.cookie',
  '*["x-api-key"]',
  '*.apiKey',
  '*.api_key',
  '*.password',
  '*.secret',
  '*.secretKey',
  '*.sessionSecret',
  '*.connectionString',
];

export function buildLoggerOptions(
  level: LogLevel,
  env: NodeEnv,
  destination?: LogDestination,
): LoggerOptions {
  const base: LoggerOptions = {
    level,
    redact: { paths: REDACT_PATHS, censor: REDACTED },
  };
  if (destination !== undefined) {
    return { ...base, stream: destination };
  }
  if (env === 'development') {
    // pino-pretty is a dev dependency: only referenced in development.
    return {
      ...base,
      transport: { target: 'pino-pretty', options: { translateTime: 'SYS:HH:MM:ss.l' } },
    };
  }
  return base;
}
