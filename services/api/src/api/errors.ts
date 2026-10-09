import type { ApiErrorCode, ApiErrorResponse } from '@wanderly/contracts';
import { hasZodFastifySchemaValidationErrors } from 'fastify-type-provider-zod';
import { isDomainError, type DomainErrorCode } from '../domain/errors.js';

/**
 * An error raised by the HTTP layer itself (rate limiting, guards…).
 * Its message is public by construction.
 */
export class HttpError extends Error {
  constructor(
    readonly statusCode: number,
    readonly code: ApiErrorCode,
    message: string,
  ) {
    super(message);
    this.name = 'HttpError';
  }
}

export type ErrorLogLevel = 'info' | 'warn' | 'error';

export interface MappedError {
  readonly statusCode: number;
  readonly body: ApiErrorResponse;
  /** 4xx are the client's problem (info); known operational 5xx warn; anything else is a bug. */
  readonly logLevel: ErrorLogLevel;
}

/** Public status and message per domain error. Domain messages themselves never reach clients. */
const DOMAIN_ERRORS = {
  NOT_FOUND: { statusCode: 404, message: 'The requested resource was not found.' },
  BUDGET_EXCEEDED: {
    statusCode: 503,
    message: "The demo's daily budget is used up. Please come back tomorrow.",
  },
  LLM_TIMEOUT: { statusCode: 504, message: 'The assistant took too long. Please try again.' },
  PROVIDER_UNAVAILABLE: {
    statusCode: 503,
    message: 'The AI service is temporarily unavailable. Please try again later.',
  },
  INVALID_OUTPUT: {
    statusCode: 502,
    message: "I couldn't produce a valid plan. Try rephrasing your request.",
  },
} as const satisfies Record<
  DomainErrorCode & ApiErrorCode,
  { statusCode: number; message: string }
>;

export const INTERNAL_ERROR_MESSAGE = 'Something went wrong on our side. Please try again.';
export const ROUTE_NOT_FOUND_MESSAGE = 'Route not found.';
const MAX_CLIENT_MESSAGE_LENGTH = 300;

export function errorBody(
  code: ApiErrorCode,
  message: string,
  requestId: string,
): ApiErrorResponse {
  return { error: { code, message, requestId } };
}

/**
 * Maps anything thrown during a request to the public error envelope.
 * 5xx responses always use a curated message: internal details stay in the logs.
 */
export function mapError(error: unknown, requestId: string): MappedError {
  if (hasZodFastifySchemaValidationErrors(error)) {
    return client(400, 'VALIDATION_ERROR', clientMessage(error, 'Invalid request.'), requestId);
  }

  if (error instanceof HttpError) {
    return {
      statusCode: error.statusCode,
      body: errorBody(error.code, error.message, requestId),
      logLevel: error.statusCode >= 500 ? 'error' : 'info',
    };
  }

  if (isDomainError(error)) {
    const { statusCode, message } = DOMAIN_ERRORS[error.code];
    return {
      statusCode,
      body: errorBody(error.code, message, requestId),
      logLevel: statusCode >= 500 ? 'warn' : 'info',
    };
  }

  const statusCode = clientStatusCode(error);
  if (statusCode !== undefined) {
    return client(statusCode, codeForClientStatus(statusCode), clientMessage(error), requestId);
  }

  return {
    statusCode: 500,
    body: errorBody('INTERNAL_ERROR', INTERNAL_ERROR_MESSAGE, requestId),
    logLevel: 'error',
  };
}

function client(
  statusCode: number,
  code: ApiErrorCode,
  message: string,
  requestId: string,
): MappedError {
  return { statusCode, body: errorBody(code, message, requestId), logLevel: 'info' };
}

/** Framework errors (invalid JSON, body too large, unsupported media type…) carry a 4xx status. */
function clientStatusCode(error: unknown): number | undefined {
  if (typeof error !== 'object' || error === null || !('statusCode' in error)) return undefined;
  const { statusCode } = error;
  return typeof statusCode === 'number' && statusCode >= 400 && statusCode < 500
    ? statusCode
    : undefined;
}

function codeForClientStatus(statusCode: number): ApiErrorCode {
  if (statusCode === 404) return 'NOT_FOUND';
  if (statusCode === 429) return 'RATE_LIMITED';
  return 'VALIDATION_ERROR';
}

/** 4xx framework messages describe the client's own request, so they are safe to return. */
function clientMessage(error: unknown, fallback = 'Invalid request.'): string {
  const message = error instanceof Error ? error.message.trim() : '';
  if (message === '') return fallback;
  return message.length > MAX_CLIENT_MESSAGE_LENGTH
    ? `${message.slice(0, MAX_CLIENT_MESSAGE_LENGTH - 1)}…`
    : message;
}
