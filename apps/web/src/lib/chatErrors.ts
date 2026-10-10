import { MAX_USER_MESSAGE_CHARS, type ApiErrorCode } from '@wanderly/contracts';
import { ApiError } from './api';

/**
 * Why something the user asked for failed, as the UI understands it. API error codes are
 * stable contract values; the other reasons describe failures the browser sees by itself.
 */
export type ChatErrorReason =
  | ApiErrorCode
  /** The API could not be reached, or the connection dropped mid-run. */
  | 'NETWORK'
  /** The stream went silent for too long. */
  | 'STREAM_TIMEOUT'
  /** The server answered something that breaks the contract. */
  | 'BAD_RESPONSE'
  /** A proxy or gateway error without the API's error envelope (502, 503, 504). */
  | 'SERVICE_UNAVAILABLE';

export interface ChatError {
  readonly reason: ChatErrorReason;
  /** Server-requested wait before retrying, when known (`Retry-After`). */
  readonly retryAfterMs: number | null;
}

export interface FriendlyError {
  readonly title: string;
  readonly message: string;
}

const GATEWAY_STATUSES = new Set([502, 503, 504]);

function reasonFromHttp(error: ApiError): ChatErrorReason {
  if (error.code !== null) {
    return error.code;
  }
  if (error.status === 429) {
    return 'RATE_LIMITED';
  }
  if (error.status === 404) {
    return 'NOT_FOUND';
  }
  if (error.status !== null && GATEWAY_STATUSES.has(error.status)) {
    return 'SERVICE_UNAVAILABLE';
  }
  return 'INTERNAL_ERROR';
}

/** Classifies any thrown value. Raw messages are dropped on purpose: they never reach the UI. */
export function toChatError(error: unknown): ChatError {
  if (!(error instanceof ApiError)) {
    return { reason: 'INTERNAL_ERROR', retryAfterMs: null };
  }
  switch (error.kind) {
    case 'http':
      return { reason: reasonFromHttp(error), retryAfterMs: error.retryAfterMs };
    case 'network':
    case 'aborted':
      return { reason: 'NETWORK', retryAfterMs: null };
    case 'timeout':
      return { reason: 'STREAM_TIMEOUT', retryAfterMs: null };
    case 'invalid-response':
      return { reason: 'BAD_RESPONSE', retryAfterMs: null };
  }
}

/** "about 45 seconds", "about 2 minutes": a wait rounded up, never shown as 0. */
export function describeWait(ms: number): string {
  const seconds = Math.max(1, Math.ceil(ms / 1000));
  if (seconds < 90) {
    return `about ${seconds} second${seconds === 1 ? '' : 's'}`;
  }
  const minutes = Math.ceil(seconds / 60);
  return `about ${minutes} minutes`;
}

/**
 * The words the user sees for each failure. The server's own error message is deliberately not
 * displayed: wording is owned by the UI, and the server text belongs in logs and traces.
 */
export function describeChatError(error: ChatError): FriendlyError {
  switch (error.reason) {
    case 'RATE_LIMITED':
      return {
        title: 'Too many requests',
        message:
          error.retryAfterMs === null
            ? 'Please wait a minute before sending another message.'
            : `Please wait ${describeWait(error.retryAfterMs)} before sending another message.`,
      };
    case 'BUDGET_EXCEEDED':
      return {
        title: 'Daily budget used up',
        message: "The demo's daily budget is used up. Back tomorrow!",
      };
    case 'LLM_TIMEOUT':
      return {
        title: 'The assistant took too long',
        message: 'The assistant took too long to answer. Please try again.',
      };
    case 'PROVIDER_UNAVAILABLE':
      return {
        title: 'AI service unavailable',
        message: 'The AI service is temporarily unavailable. Please try again in a few minutes.',
      };
    case 'INVALID_OUTPUT':
      return {
        title: "Couldn't build a valid plan",
        message: "I couldn't produce a valid plan for this request. Try rephrasing it.",
      };
    case 'VALIDATION_ERROR':
      return {
        title: 'Message not accepted',
        message: `Messages must not be empty and must stay under ${MAX_USER_MESSAGE_CHARS.toLocaleString('en')} characters.`,
      };
    case 'NOT_FOUND':
      return {
        title: 'Trip not found',
        message:
          'This trip is no longer available. Conversations are deleted after 30 days. Start a new trip.',
      };
    case 'INTERNAL_ERROR':
      return {
        title: 'Something went wrong',
        message: 'Something went wrong on our side. Please try again.',
      };
    case 'NETWORK':
      return {
        title: 'Connection problem',
        message: "Wanderly can't be reached right now. Check your connection and try again.",
      };
    case 'STREAM_TIMEOUT':
      return {
        title: 'No response',
        message: 'The server stopped responding. Please try again.',
      };
    case 'BAD_RESPONSE':
      return {
        title: 'Unexpected response',
        message:
          "The server sent a response this page doesn't understand. Please reload and try again.",
      };
    case 'SERVICE_UNAVAILABLE':
      return {
        title: 'Service unavailable',
        message: 'Wanderly is temporarily unavailable. Please try again in a few minutes.',
      };
  }
}
