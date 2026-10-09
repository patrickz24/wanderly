/** Polite HTTP for the data scripts: identified User-Agent, sequential pacing, bounded retries. */

export const USER_AGENT = 'WanderlyCorpusBot/0.1 (https://github.com/patrickz24/wanderly)';

const RETRYABLE_STATUS = new Set([429, 500, 502, 503, 504]);

export const sleep = (ms: number): Promise<void> =>
  new Promise((resolve) => {
    setTimeout(resolve, ms);
  });

/** Guarantees a minimum delay between two consecutive requests (requests are sequential). */
export class RequestPacer {
  private last = 0;

  constructor(private readonly minIntervalMs: number) {}

  async wait(): Promise<void> {
    const elapsed = Date.now() - this.last;
    if (elapsed < this.minIntervalMs) await sleep(this.minIntervalMs - elapsed);
    this.last = Date.now();
  }
}

export class HttpError extends Error {
  constructor(
    message: string,
    readonly status: number | null,
  ) {
    super(message);
    this.name = 'HttpError';
  }
}

function retryDelayMs(response: Response | null, attempt: number): number {
  const header = response?.headers.get('retry-after');
  const seconds = header === null || header === undefined ? Number.NaN : Number(header);
  if (Number.isFinite(seconds)) return Math.min(seconds, 60) * 1000;
  // Rate limited without a hint: per-minute quotas reset within a minute.
  if (response?.status === 429) return 60_000;
  return Math.min(2 ** attempt * 2000, 30_000);
}

/**
 * GETs a JSON document. Retries network errors, 429 and 5xx (honouring `Retry-After`), then
 * fails with an explicit error. The body is returned as `unknown`: callers validate it with Zod.
 */
export async function getJson(
  url: URL,
  options: { readonly pacer: RequestPacer; readonly retries?: number; readonly timeoutMs?: number },
): Promise<unknown> {
  const retries = options.retries ?? 3;
  for (let attempt = 0; ; attempt++) {
    await options.pacer.wait();
    let response: Response | null = null;
    try {
      response = await fetch(url, {
        headers: { 'User-Agent': USER_AGENT, Accept: 'application/json' },
        signal: AbortSignal.timeout(options.timeoutMs ?? 60_000),
      });
    } catch (error) {
      if (attempt >= retries) {
        throw new HttpError(`GET ${url.origin}${url.pathname} failed: ${String(error)}`, null);
      }
    }
    if (response?.ok) return response.json();
    if (response !== null && !RETRYABLE_STATUS.has(response.status)) {
      const body = (await response.text()).slice(0, 300);
      throw new HttpError(`GET ${url.href} → HTTP ${response.status}: ${body}`, response.status);
    }
    if (attempt >= retries) {
      throw new HttpError(
        `GET ${url.href} still failing after ${retries} retries`,
        response?.status ?? null,
      );
    }
    const delay = retryDelayMs(response, attempt);
    console.warn(`  retrying in ${delay} ms (${response?.status ?? 'network error'})`);
    await sleep(delay);
  }
}
