import { stubFetch, type FetchImpl } from './fetch';

export type RouteHandler = (init: RequestInit | undefined) => Response | Promise<Response>;

/**
 * Stubs `fetch` with a table of `"METHOD /path"` handlers. An unexpected request fails the
 * test loudly instead of hanging.
 */
export function routeFetch(routes: Record<string, RouteHandler>) {
  const impl: FetchImpl = async (input, init) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    const key = `${init?.method ?? 'GET'} ${url}`;
    const handler = routes[key];
    if (handler === undefined) {
      throw new Error(`Unexpected request: ${key}`);
    }
    return handler(init);
  };
  return stubFetch(impl);
}

/** Calls of a stubbed fetch matching `"METHOD /path"`. */
export function callsTo(
  mock: ReturnType<typeof routeFetch>,
  key: string,
): (RequestInit | undefined)[] {
  return mock.mock.calls
    .filter(([input, init]) => `${init?.method ?? 'GET'} ${String(input)}` === key)
    .map(([, init]) => init);
}
