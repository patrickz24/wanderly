import { afterEach, describe, expect, it, vi } from 'vitest';
import { hangingFetch, jsonResponse, stubFetch } from '../test/fetch';
import { ApiError, apiRequest, getHealth, normalizeBaseUrl, resolveApiUrl } from './api';

const identity = (data: unknown): unknown => data;

afterEach(() => {
  vi.useRealTimers();
});

describe('normalizeBaseUrl', () => {
  it.each([
    [undefined, ''],
    ['', ''],
    ['  ', ''],
    ['https://api.example.test', 'https://api.example.test'],
    ['https://api.example.test///', 'https://api.example.test'],
    ['https://example.test/wanderly/', 'https://example.test/wanderly'],
  ])('normalizes %j to %j', (raw, expected) => {
    expect(normalizeBaseUrl(raw)).toBe(expected);
  });
});

describe('resolveApiUrl', () => {
  it('keeps same-origin paths relative when no base URL is configured', () => {
    expect(resolveApiUrl('/health', '')).toBe('/health');
  });

  it('prefixes the configured base URL', () => {
    expect(resolveApiUrl('/api/conversations', 'https://api.example.test')).toBe(
      'https://api.example.test/api/conversations',
    );
  });

  it('rejects paths that are not absolute', () => {
    expect(() => resolveApiUrl('health', '')).toThrow(TypeError);
  });
});

describe('apiRequest', () => {
  it('returns the decoded JSON body of a 2xx response', async () => {
    const fetchMock = stubFetch(async () => jsonResponse({ status: 'ok' }));

    await expect(apiRequest('/health', identity)).resolves.toEqual({ status: 'ok' });

    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toBe('/health');
    expect(init?.method).toBe('GET');
    expect(new Headers(init?.headers).get('Accept')).toBe('application/json');
    expect(init?.body).toBeUndefined();
  });

  it('serialises a JSON body', async () => {
    const fetchMock = stubFetch(async () => jsonResponse({ id: 'c1' }, 201));

    await apiRequest('/api/conversations', identity, { method: 'POST', body: { title: 'Lisbon' } });

    const [, init] = fetchMock.mock.calls[0]!;
    expect(init?.method).toBe('POST');
    expect(init?.body).toBe('{"title":"Lisbon"}');
    expect(new Headers(init?.headers).get('Content-Type')).toBe('application/json');
  });

  it('maps a non-2xx error envelope to an http ApiError with its code', async () => {
    stubFetch(async () =>
      jsonResponse(
        { error: { code: 'RATE_LIMITED', message: 'Too many requests.', requestId: 'req-1' } },
        429,
      ),
    );

    await expect(apiRequest('/api/conversations', identity)).rejects.toMatchObject({
      name: 'ApiError',
      kind: 'http',
      status: 429,
      code: 'RATE_LIMITED',
      requestId: 'req-1',
      message: 'Too many requests.',
    });
  });

  it('maps a non-2xx response without an envelope to a generic http ApiError', async () => {
    stubFetch(async () => new Response('<html>Bad Gateway</html>', { status: 502 }));

    await expect(apiRequest('/health', identity)).rejects.toMatchObject({
      kind: 'http',
      status: 502,
      code: null,
      message: 'The API responded with HTTP 502.',
    });
  });

  it('rejects a 2xx body that is not JSON', async () => {
    stubFetch(async () => new Response('<html>index</html>', { status: 200 }));

    await expect(apiRequest('/health', identity)).rejects.toMatchObject({
      kind: 'invalid-response',
    });
  });

  it('rejects a 2xx body that does not match the decoder', async () => {
    stubFetch(async () => jsonResponse({ status: 'degraded' }));
    const decoder = (): never => {
      throw new Error('unexpected shape');
    };

    const error: unknown = await apiRequest('/health', decoder).catch((e: unknown) => e);

    expect(error).toBeInstanceOf(ApiError);
    expect(error).toMatchObject({ kind: 'invalid-response' });
    expect((error as ApiError).cause).toEqual(new Error('unexpected shape'));
  });

  it('maps a rejected fetch to a network ApiError', async () => {
    stubFetch(async () => {
      throw new TypeError('Failed to fetch');
    });

    await expect(apiRequest('/health', identity)).rejects.toMatchObject({
      kind: 'network',
      status: null,
    });
  });

  it('aborts and reports a timeout when the API does not answer in time', async () => {
    vi.useFakeTimers();
    const fetchMock = stubFetch(hangingFetch);

    // Capture the rejection eagerly so it is handled before the timer fires.
    const outcome = apiRequest('/health', identity, { timeoutMs: 1_000 }).catch((e: unknown) => e);
    await vi.advanceTimersByTimeAsync(999);
    expect(fetchMock.mock.calls[0]![1]?.signal?.aborted).toBe(false);
    await vi.advanceTimersByTimeAsync(1);

    expect(await outcome).toMatchObject({
      kind: 'timeout',
      message: 'The API did not respond within 1000 ms.',
    });
    expect(fetchMock.mock.calls[0]![1]?.signal?.aborted).toBe(true);
  });

  it('reports an aborted ApiError when the caller cancels', async () => {
    stubFetch(hangingFetch);
    const controller = new AbortController();

    const pending = apiRequest('/health', identity, { signal: controller.signal });
    controller.abort();

    await expect(pending).rejects.toMatchObject({ kind: 'aborted' });
  });

  it('does not call the API when the caller signal is already aborted', async () => {
    const fetchMock = stubFetch(hangingFetch);

    await expect(
      apiRequest('/health', identity, { signal: AbortSignal.abort() }),
    ).rejects.toMatchObject({ kind: 'aborted' });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('clears its timeout once the response has arrived', async () => {
    vi.useFakeTimers();
    stubFetch(async () => jsonResponse({ status: 'ok' }));

    await apiRequest('/health', identity);

    expect(vi.getTimerCount()).toBe(0);
  });
});

describe('getHealth', () => {
  it('validates the liveness payload against the shared contract', async () => {
    stubFetch(async () => jsonResponse({ status: 'ok' }));

    await expect(getHealth()).resolves.toEqual({ status: 'ok' });
  });

  it('rejects a payload that breaks the contract', async () => {
    stubFetch(async () => jsonResponse({ status: 'maybe' }));

    await expect(getHealth()).rejects.toMatchObject({ kind: 'invalid-response' });
  });
});
