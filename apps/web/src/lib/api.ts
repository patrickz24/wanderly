import {
  ApiErrorResponseSchema,
  HealthResponseSchema,
  type ApiErrorCode,
  type HealthResponse,
} from '@wanderly/contracts';

/** Why a request failed, from the browser's point of view. */
export type ApiFailureKind =
  /** No complete response before the deadline. */
  | 'timeout'
  /** The caller cancelled, e.g. the component unmounted. */
  | 'aborted'
  /** `fetch` rejected: offline, DNS failure, connection refused, CORS. */
  | 'network'
  /** The server answered with a non-2xx status. */
  | 'http'
  /** 2xx, but the body is not JSON or does not match the contract. */
  | 'invalid-response';

interface ApiErrorDetails {
  readonly status?: number;
  readonly code?: ApiErrorCode;
  readonly requestId?: string;
  /** From the `Retry-After` header, when the server sent one. */
  readonly retryAfterMs?: number;
  readonly cause?: unknown;
}

/** The only error type the API client throws, so callers can branch on `kind`. */
export class ApiError extends Error {
  override readonly name = 'ApiError';
  readonly kind: ApiFailureKind;
  /** HTTP status when the server answered, otherwise `null`. */
  readonly status: number | null;
  /** Stable code from the API error envelope, when the body carried one. */
  readonly code: ApiErrorCode | null;
  readonly requestId: string | null;
  /** How long the server asked us to wait before retrying (`Retry-After`), otherwise `null`. */
  readonly retryAfterMs: number | null;

  constructor(kind: ApiFailureKind, message: string, details: ApiErrorDetails = {}) {
    super(message, { cause: details.cause });
    this.kind = kind;
    this.status = details.status ?? null;
    this.code = details.code ?? null;
    this.requestId = details.requestId ?? null;
    this.retryAfterMs = details.retryAfterMs ?? null;
  }
}

/** Turns an untrusted JSON value into a typed one, throwing when it does not match. */
export type Decoder<T> = (data: unknown) => T;

export type HttpMethod = 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';

export interface ApiRequestOptions {
  readonly method?: HttpMethod;
  /** Serialised as JSON. */
  readonly body?: unknown;
  /** Cancels the request; surfaces as an `aborted` ApiError. */
  readonly signal?: AbortSignal;
  readonly timeoutMs?: number;
}

export const DEFAULT_TIMEOUT_MS = 10_000;

/** Removes trailing slashes; `undefined` or blank means same origin. */
export function normalizeBaseUrl(raw: string | undefined): string {
  return (raw ?? '').trim().replace(/\/+$/, '');
}

const API_BASE_URL = normalizeBaseUrl(import.meta.env.VITE_API_BASE_URL);

/** Joins the configured base URL and an absolute API path such as `/health`. */
export function resolveApiUrl(path: string, baseUrl: string = API_BASE_URL): string {
  if (!path.startsWith('/')) {
    throw new TypeError(`API paths must start with "/", got "${path}".`);
  }
  return `${baseUrl}${path}`;
}

type JsonParseResult = { readonly ok: true; readonly value: unknown } | { readonly ok: false };

function parseJson(text: string): JsonParseResult {
  if (text === '') {
    return { ok: true, value: undefined };
  }
  try {
    return { ok: true, value: JSON.parse(text) };
  } catch {
    return { ok: false };
  }
}

/**
 * Parses a `Retry-After` header: delay-seconds or an HTTP date (RFC 9110 §10.2.3).
 * Returns the wait in milliseconds, or `null` when the header is absent or malformed.
 */
export function parseRetryAfter(value: string | null, now: number = Date.now()): number | null {
  const trimmed = value?.trim() ?? '';
  if (trimmed === '') {
    return null;
  }
  if (/^\d+$/.test(trimmed)) {
    return Number(trimmed) * 1000;
  }
  // HTTP dates start with the day name; this keeps Date.parse's leniency ("-5", "1.5") out.
  if (!/^[A-Za-z]{3},? /.test(trimmed)) {
    return null;
  }
  const date = Date.parse(trimmed);
  return Number.isNaN(date) ? null : Math.max(0, date - now);
}

/** Builds an `http` error, using the API error envelope when the body is one. */
export function toHttpError(status: number, body: string, headers?: Headers): ApiError {
  const retryAfterMs = parseRetryAfter(headers?.get('Retry-After') ?? null) ?? undefined;
  const parsed = parseJson(body);
  const envelope = parsed.ok ? ApiErrorResponseSchema.safeParse(parsed.value) : null;
  if (envelope?.success === true) {
    const { code, message, requestId } = envelope.data.error;
    return new ApiError('http', message, { status, code, requestId, retryAfterMs });
  }
  return new ApiError('http', `The API responded with HTTP ${status}.`, { status, retryAfterMs });
}

function decodeBody<T>(body: string, decode: Decoder<T>): T {
  const parsed = parseJson(body);
  if (!parsed.ok) {
    throw new ApiError('invalid-response', 'The API response is not valid JSON.');
  }
  try {
    return decode(parsed.value);
  } catch (error) {
    throw new ApiError('invalid-response', 'The API response does not match the contract.', {
      cause: error,
    });
  }
}

function buildInit(method: HttpMethod, body: unknown, signal: AbortSignal): RequestInit {
  const headers = new Headers({ Accept: 'application/json' });
  if (body === undefined) {
    return { method, headers, signal };
  }
  headers.set('Content-Type', 'application/json');
  return { method, headers, signal, body: JSON.stringify(body) };
}

/**
 * Typed JSON request against the Wanderly API.
 *
 * The deadline covers the whole exchange (headers and body). Credentials use the fetch
 * default (`same-origin`), which matches the production setup where nginx serves the app
 * and proxies the API on the same origin.
 *
 * @throws {ApiError} for every runtime failure, never a raw `TypeError` or `DOMException`.
 * Only a malformed `path` (a programming error) rejects with a `TypeError`.
 */
export async function apiRequest<T>(
  path: string,
  decode: Decoder<T>,
  options: ApiRequestOptions = {},
): Promise<T> {
  const { method = 'GET', body, signal, timeoutMs = DEFAULT_TIMEOUT_MS } = options;
  const url = resolveApiUrl(path);
  if (signal?.aborted === true) {
    throw new ApiError('aborted', 'The request was cancelled.', { cause: signal.reason });
  }

  // One controller aborts the fetch on either the deadline or the caller's signal.
  const controller = new AbortController();
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, timeoutMs);
  const forwardAbort = (): void => {
    controller.abort();
  };
  signal?.addEventListener('abort', forwardAbort, { once: true });

  try {
    const response = await fetch(url, buildInit(method, body, controller.signal));
    const text = await response.text();
    if (!response.ok) {
      throw toHttpError(response.status, text, response.headers);
    }
    return decodeBody(text, decode);
  } catch (error) {
    if (error instanceof ApiError) {
      throw error;
    }
    if (timedOut) {
      throw new ApiError('timeout', `The API did not respond within ${timeoutMs} ms.`, {
        cause: error,
      });
    }
    if (controller.signal.aborted) {
      throw new ApiError('aborted', 'The request was cancelled.', { cause: error });
    }
    throw new ApiError('network', 'The API could not be reached.', { cause: error });
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener('abort', forwardAbort);
  }
}

/** Liveness is cheap: fail fast so the status indicator reacts quickly. */
export const HEALTH_TIMEOUT_MS = 5_000;

/** `GET /health`: is the API process up? */
export function getHealth(signal?: AbortSignal): Promise<HealthResponse> {
  return apiRequest('/health', (data) => HealthResponseSchema.parse(data), {
    signal,
    timeoutMs: HEALTH_TIMEOUT_MS,
  });
}
