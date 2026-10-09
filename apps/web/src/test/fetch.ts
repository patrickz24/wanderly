import { vi } from 'vitest';

export type FetchImpl = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;

/** Replaces the global `fetch` for the current test (restored by `unstubGlobals`). */
export function stubFetch(impl: FetchImpl) {
  const mock = vi.fn<FetchImpl>(impl);
  vi.stubGlobal('fetch', mock);
  return mock;
}

export function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

/** Behaves like a real fetch to a server that never answers: it only settles when aborted. */
export const hangingFetch: FetchImpl = (_input, init) =>
  new Promise<Response>((_resolve, reject) => {
    const abort = (): void => {
      reject(new DOMException('The operation was aborted.', 'AbortError'));
    };
    if (init?.signal?.aborted === true) {
      abort();
    }
    init?.signal?.addEventListener('abort', abort);
  });
