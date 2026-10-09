import { useEffect, useState } from 'react';
import { ApiError, getHealth } from '../lib/api';

export type ApiStatus =
  | { readonly state: 'checking' }
  | { readonly state: 'online' }
  | { readonly state: 'unavailable'; readonly detail: string };

/** Resolves when the API is alive, rejects otherwise. Must honour the abort signal. */
export type HealthCheck = (signal: AbortSignal) => Promise<unknown>;

export const DEFAULT_POLL_INTERVAL_MS = 30_000;

const CHECKING: ApiStatus = { state: 'checking' };
const ONLINE: ApiStatus = { state: 'online' };

/** Short, human-readable reason shown next to "API unavailable". */
export function describeFailure(error: unknown): string {
  if (!(error instanceof ApiError)) {
    return 'unexpected error';
  }
  switch (error.kind) {
    case 'timeout':
      return 'timed out';
    case 'network':
      return 'unreachable';
    case 'http':
      return error.status === null ? 'server error' : `HTTP ${error.status}`;
    case 'invalid-response':
      return 'unexpected response';
    case 'aborted':
      return 'cancelled';
  }
}

/**
 * Polls the API liveness endpoint. Between polls the last known status is kept (no flip back
 * to "checking"), so a screen reader only hears an announcement when the status changes.
 */
export function useApiStatus(
  check: HealthCheck = getHealth,
  pollIntervalMs: number = DEFAULT_POLL_INTERVAL_MS,
): ApiStatus {
  const [status, setStatus] = useState<ApiStatus>(CHECKING);

  useEffect(() => {
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;

    const poll = async (): Promise<void> => {
      let next: ApiStatus;
      try {
        await check(controller.signal);
        next = ONLINE;
      } catch (error) {
        next = { state: 'unavailable', detail: describeFailure(error) };
      }
      if (controller.signal.aborted) {
        return;
      }
      setStatus((previous) => (isSameStatus(previous, next) ? previous : next));
      timer = setTimeout(() => void poll(), pollIntervalMs);
    };

    void poll();
    return () => {
      controller.abort();
      clearTimeout(timer);
    };
  }, [check, pollIntervalMs]);

  return status;
}

function isSameStatus(a: ApiStatus, b: ApiStatus): boolean {
  if (a.state === 'unavailable' && b.state === 'unavailable') {
    return a.detail === b.detail;
  }
  return a.state === b.state;
}
