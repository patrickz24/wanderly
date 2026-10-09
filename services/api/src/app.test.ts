import { ApiErrorResponseSchema, ReadyResponseSchema } from '@wanderly/contracts';
import { afterEach, describe, expect, it } from 'vitest';
import { z } from 'zod';
import { fakeProbe, memoryLog, testConfig, type MemoryLog } from '../test/support.js';
import type { ReadinessReport } from './application/ports/readiness.js';
import { BODY_LIMIT_BYTES, buildApp, requestIdFrom, type App } from './app.js';
import { BudgetExceededError } from './domain/errors.js';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

let app: App | undefined;

afterEach(async () => {
  await app?.close();
  app = undefined;
});

async function start(
  options: { env?: Record<string, string>; report?: ReadinessReport; log?: MemoryLog } = {},
): Promise<App> {
  app = await buildApp({
    config: testConfig(options.env),
    readinessProbe: fakeProbe(options.report),
    ...(options.log === undefined ? {} : { logDestination: options.log }),
  });
  return app;
}

describe('GET /health', () => {
  it('reports liveness without touching dependencies', async () => {
    const server = await start({
      report: { status: 'fail', checks: {} },
    });

    const response = await server.inject({ method: 'GET', url: '/health' });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ status: 'ok' });
    expect(response.headers['content-type']).toContain('application/json');
  });
});

describe('GET /ready', () => {
  it('returns 200 with per-check status when every check passes', async () => {
    const server = await start({
      report: {
        status: 'pass',
        checks: {
          database: { status: 'pass', durationMs: 2 },
          migrations: { status: 'pass', durationMs: 3 },
        },
      },
    });

    const response = await server.inject({ method: 'GET', url: '/ready' });

    expect(response.statusCode).toBe(200);
    expect(ReadyResponseSchema.parse(response.json())).toEqual({
      status: 'pass',
      checks: {
        database: { status: 'pass', durationMs: 2 },
        migrations: { status: 'pass', durationMs: 3 },
      },
    });
  });

  it('returns 503 with public output only and logs the internal detail', async () => {
    const log = memoryLog();
    const cause = new Error('password authentication failed for user "wanderly"');
    const server = await start({
      env: { LOG_LEVEL: 'info' },
      log,
      report: {
        status: 'fail',
        checks: {
          database: { status: 'fail', durationMs: 5, output: 'check failed', detail: cause },
          migrations: {
            status: 'fail',
            durationMs: 1,
            output: '1 pending migration(s)',
            detail: { pending: ['1760000000000_next'] },
          },
        },
      },
    });

    const response = await server.inject({ method: 'GET', url: '/ready' });

    expect(response.statusCode).toBe(503);
    expect(response.json()).toEqual({
      status: 'fail',
      checks: {
        database: { status: 'fail', durationMs: 5, output: 'check failed' },
        migrations: { status: 'fail', durationMs: 1, output: '1 pending migration(s)' },
      },
    });
    expect(response.body).not.toContain('password');
    expect(response.body).not.toContain('1760000000000_next');

    const warnings = log.entries().filter((entry) => entry['msg'] === 'readiness check failed');
    expect(warnings).toHaveLength(2);
    expect(JSON.stringify(warnings)).toContain('password authentication failed');
    expect(JSON.stringify(warnings)).toContain('1760000000000_next');
  });
});

describe('request ids', () => {
  it('generates a UUID and echoes it in the x-request-id header', async () => {
    const server = await start();
    const response = await server.inject({ method: 'GET', url: '/health' });
    expect(response.headers['x-request-id']).toMatch(UUID);
  });

  it('reuses a well-formed upstream request id', async () => {
    const server = await start();
    const response = await server.inject({
      method: 'GET',
      url: '/nope',
      headers: { 'x-request-id': 'edge-42.abc:7' },
    });
    expect(response.headers['x-request-id']).toBe('edge-42.abc:7');
    expect(response.json()).toMatchObject({ error: { requestId: 'edge-42.abc:7' } });
  });

  it.each(['has spaces', 'x'.repeat(129), 'quote"inject', ''])(
    'replaces a malformed upstream id (%j)',
    (incoming) => {
      expect(requestIdFrom({ headers: { 'x-request-id': incoming } })).toMatch(UUID);
    },
  );

  it('ignores repeated request id headers', () => {
    expect(requestIdFrom({ headers: { 'x-request-id': ['a', 'b'] as unknown as string } })).toMatch(
      UUID,
    );
  });
});

describe('trust proxy', () => {
  const clientIp = async (env: Record<string, string>) => {
    const server = await start({ env });
    server.get('/ip', async (request) => ({ ip: request.ip }));
    const response = await server.inject({
      method: 'GET',
      url: '/ip',
      headers: { 'x-forwarded-for': '203.0.113.7' },
    });
    return (response.json() as { ip: string }).ip;
  };

  it('ignores X-Forwarded-For by default', async () => {
    expect(await clientIp({})).toBe('127.0.0.1');
  });

  it('trusts X-Forwarded-For from an allowlisted proxy address', async () => {
    expect(await clientIp({ TRUST_PROXY: '127.0.0.1' })).toBe('203.0.113.7');
  });

  it('does not trust X-Forwarded-For from other peers', async () => {
    expect(await clientIp({ TRUST_PROXY: '10.0.0.0/8' })).toBe('127.0.0.1');
  });
});

describe('security headers', () => {
  it('sets a strict CSP and hardening headers suited to a JSON API', async () => {
    const server = await start();
    const { headers } = await server.inject({ method: 'GET', url: '/health' });

    expect(headers['content-security-policy']).toBe(
      "default-src 'none';base-uri 'none';form-action 'none';frame-ancestors 'none'",
    );
    expect(headers['x-content-type-options']).toBe('nosniff');
    expect(headers['strict-transport-security']).toContain('max-age=');
    expect(headers['referrer-policy']).toBe('no-referrer');
    expect(headers['cross-origin-resource-policy']).toBe('same-origin');
    expect(headers['cache-control']).toBe('no-store');
    expect(headers['x-powered-by']).toBeUndefined();
  });

  it('applies the same headers to error responses', async () => {
    const server = await start();
    const { headers } = await server.inject({ method: 'GET', url: '/missing' });
    expect(headers['content-security-policy']).toContain("default-src 'none'");
    expect(headers['x-request-id']).toMatch(UUID);
  });
});

describe('CORS', () => {
  const env = { CORS_ORIGINS: 'https://app.wanderly.example' };

  it('allows an allowlisted origin with credentials', async () => {
    const server = await start({ env });
    const response = await server.inject({
      method: 'GET',
      url: '/health',
      headers: { origin: 'https://app.wanderly.example' },
    });
    expect(response.headers['access-control-allow-origin']).toBe('https://app.wanderly.example');
    expect(response.headers['access-control-allow-credentials']).toBe('true');
    expect(response.headers['access-control-expose-headers']).toContain('X-Request-Id');
  });

  it('does not allow other origins', async () => {
    const server = await start({ env });
    const response = await server.inject({
      method: 'GET',
      url: '/health',
      headers: { origin: 'https://evil.example' },
    });
    expect(response.headers['access-control-allow-origin']).toBeUndefined();
  });

  it('answers preflight requests for allowlisted origins only', async () => {
    const server = await start({ env });
    const preflight = (origin: string) =>
      server.inject({
        method: 'OPTIONS',
        url: '/api/conversations',
        headers: { origin, 'access-control-request-method': 'POST' },
      });

    const allowed = await preflight('https://app.wanderly.example');
    expect(allowed.statusCode).toBe(204);
    expect(allowed.headers['access-control-allow-methods']).toBe('GET, HEAD, POST');
    expect(allowed.headers['access-control-allow-headers']).toBe('Content-Type, X-Request-Id');

    const denied = await preflight('https://evil.example');
    expect(denied.headers['access-control-allow-origin']).toBeUndefined();
  });
});

describe('error handling', () => {
  async function startWithFailingRoutes(log: MemoryLog = memoryLog()): Promise<App> {
    const server = await start({ env: { LOG_LEVEL: 'info' }, log });
    server.get('/boom', async () => {
      throw new Error('connect ECONNREFUSED 10.0.0.5:5432 user=wanderly password=hunter2');
    });
    server.get('/budget', async () => {
      throw new BudgetExceededError(2.31, 2);
    });
    server.get(
      '/items',
      { schema: { querystring: z.object({ limit: z.coerce.number().int().min(1) }) } },
      async (request) => ({ limit: request.query.limit }),
    );
    server.post(
      '/echo',
      { schema: { body: z.object({ text: z.string().max(10) }) } },
      async (request) => request.body,
    );
    server.get(
      '/bad-response',
      { schema: { response: { 200: z.object({ id: z.string() }) } } },
      async () => ({ id: 42 }) as unknown as { id: string },
    );
    return server;
  }

  it('hides unexpected errors behind a generic 500 and logs them with the stack', async () => {
    const log = memoryLog();
    const server = await startWithFailingRoutes(log);

    const response = await server.inject({ method: 'GET', url: '/boom' });

    expect(response.statusCode).toBe(500);
    const body = ApiErrorResponseSchema.parse(response.json());
    expect(body.error.code).toBe('INTERNAL_ERROR');
    expect(body.error.requestId).toBe(response.headers['x-request-id']);
    expect(response.body).not.toContain('hunter2');
    expect(response.body).not.toContain('ECONNREFUSED');
    expect(response.body).not.toContain('at ');

    const logged = log.entries().find((entry) => entry['msg'] === 'request failed');
    expect(logged?.['level']).toBe(50);
    expect(JSON.stringify(logged)).toContain('ECONNREFUSED');
    expect(JSON.stringify(logged)).toContain('stack');
  });

  it('maps domain errors to their public status and message', async () => {
    const server = await startWithFailingRoutes();
    const response = await server.inject({ method: 'GET', url: '/budget' });

    expect(response.statusCode).toBe(503);
    expect(response.json()).toMatchObject({
      error: { code: 'BUDGET_EXCEEDED', message: expect.stringContaining('daily budget') },
    });
    expect(response.body).not.toContain('2.31');
  });

  it('returns 400 VALIDATION_ERROR for an invalid querystring', async () => {
    const server = await startWithFailingRoutes();
    const response = await server.inject({ method: 'GET', url: '/items?limit=0' });

    expect(response.statusCode).toBe(400);
    const body = ApiErrorResponseSchema.parse(response.json());
    expect(body.error.code).toBe('VALIDATION_ERROR');
    expect(body.error.message).toContain('limit');
  });

  it('returns 400 VALIDATION_ERROR for an invalid body', async () => {
    const server = await startWithFailingRoutes();
    const response = await server.inject({
      method: 'POST',
      url: '/echo',
      payload: { text: 'far too long for the schema' },
    });

    expect(response.statusCode).toBe(400);
    expect(response.json()).toMatchObject({ error: { code: 'VALIDATION_ERROR' } });
  });

  it('returns 400 VALIDATION_ERROR for malformed JSON', async () => {
    const server = await startWithFailingRoutes();
    const response = await server.inject({
      method: 'POST',
      url: '/echo',
      headers: { 'content-type': 'application/json' },
      payload: '{"text":',
    });

    expect(response.statusCode).toBe(400);
    expect(response.json()).toMatchObject({ error: { code: 'VALIDATION_ERROR' } });
  });

  it('rejects bodies above the size limit', async () => {
    const server = await startWithFailingRoutes();
    const response = await server.inject({
      method: 'POST',
      url: '/echo',
      payload: { text: 'x'.repeat(BODY_LIMIT_BYTES) },
    });

    expect(response.statusCode).toBe(413);
    expect(response.json()).toMatchObject({ error: { code: 'VALIDATION_ERROR' } });
  });

  it('rejects unsupported media types', async () => {
    const server = await startWithFailingRoutes();
    const response = await server.inject({
      method: 'POST',
      url: '/echo',
      headers: { 'content-type': 'text/xml' },
      payload: '<text/>',
    });

    expect(response.statusCode).toBe(415);
    expect(response.json()).toMatchObject({ error: { code: 'VALIDATION_ERROR' } });
  });

  it('treats a response that breaks its own schema as an internal error', async () => {
    const server = await startWithFailingRoutes();
    const response = await server.inject({ method: 'GET', url: '/bad-response' });

    expect(response.statusCode).toBe(500);
    expect(response.json()).toMatchObject({ error: { code: 'INTERNAL_ERROR' } });
  });

  it('answers unknown routes with a NOT_FOUND envelope', async () => {
    const server = await start();
    const response = await server.inject({ method: 'GET', url: '/does-not-exist?x=<script>' });

    expect(response.statusCode).toBe(404);
    expect(ApiErrorResponseSchema.parse(response.json())).toEqual({
      error: {
        code: 'NOT_FOUND',
        message: 'Route not found.',
        requestId: response.headers['x-request-id'],
      },
    });
  });
});

describe('rate limiting', () => {
  it('is opt-in: routes without rate-limit config are not limited', async () => {
    const server = await start({ env: { RATE_LIMIT_MAX: '1' } });
    for (let i = 0; i < 3; i += 1) {
      const response = await server.inject({ method: 'GET', url: '/health' });
      expect(response.statusCode).toBe(200);
    }
  });

  it('limits opted-in routes with the configured defaults and the error envelope', async () => {
    const server = await start({ env: { RATE_LIMIT_MAX: '2', RATE_LIMIT_WINDOW_MS: '60000' } });
    server.post('/limited', { config: { rateLimit: {} } }, async () => ({ ok: true }));

    const statuses: number[] = [];
    let last;
    for (let i = 0; i < 3; i += 1) {
      last = await server.inject({ method: 'POST', url: '/limited' });
      statuses.push(last.statusCode);
    }

    expect(statuses).toEqual([200, 200, 429]);
    expect(last?.headers['retry-after']).toBe('60');
    expect(last?.json()).toMatchObject({
      error: { code: 'RATE_LIMITED', message: 'Too many requests. Please retry in 1 minute.' },
    });
  });
});

describe('cookies', () => {
  it('signs cookies with SESSION_SECRET and applies safe defaults', async () => {
    const server = await start();
    server.get('/set', async (_request, reply) => {
      reply.setCookie('sid', 'abc', { signed: true });
      return { ok: true };
    });
    server.get('/read', async (request) => {
      const raw = request.cookies['sid'];
      return { valid: raw === undefined ? false : request.unsignCookie(raw).valid };
    });

    const set = await server.inject({ method: 'GET', url: '/set' });
    const setCookie = String(set.headers['set-cookie']);
    expect(setCookie).toMatch(/^sid=abc\.[^;]+;/);
    expect(setCookie).toContain('HttpOnly');
    expect(setCookie).toContain('SameSite=Lax');
    expect(setCookie).toContain('Path=/');
    expect(setCookie).not.toContain('Secure');

    const signed = setCookie.split(';')[0] ?? '';
    const valid = await server.inject({ method: 'GET', url: '/read', headers: { cookie: signed } });
    expect(valid.json()).toEqual({ valid: true });

    const forged = await server.inject({
      method: 'GET',
      url: '/read',
      headers: { cookie: 'sid=abc.forged' },
    });
    expect(forged.json()).toEqual({ valid: false });
  });

  it('marks cookies Secure in production', async () => {
    const server = await start({ env: { NODE_ENV: 'production' } });
    server.get('/set', async (_request, reply) => {
      reply.setCookie('sid', 'abc', { signed: true });
      return { ok: true };
    });

    const response = await server.inject({ method: 'GET', url: '/set' });
    expect(String(response.headers['set-cookie'])).toContain('Secure');
  });
});

describe('logging', () => {
  it('redacts credentials wherever they appear in log objects', async () => {
    const log = memoryLog();
    const server = await start({ env: { LOG_LEVEL: 'info' }, log });

    server.log.info(
      {
        req: { headers: { authorization: 'Bearer tok-1', cookie: 'sid=s-1', 'x-api-key': 'k-1' } },
        headers: { authorization: 'Bearer tok-2' },
        provider: { apiKey: 'sk-ant-3', secretKey: 'sk-lf-4' },
        db: { connectionString: 'postgres://u:pw-5@h/db', password: 'pw-6' },
      },
      'probe',
    );

    const output = log.lines.join('\n');
    for (const secret of ['tok-1', 's-1', 'k-1', 'tok-2', 'sk-ant-3', 'sk-lf-4', 'pw-5', 'pw-6']) {
      expect(output).not.toContain(secret);
    }
    expect(output).toContain('[redacted]');
  });

  it('never logs request headers such as Authorization or Cookie', async () => {
    const log = memoryLog();
    const server = await start({ env: { LOG_LEVEL: 'info' }, log });

    await server.inject({
      method: 'GET',
      url: '/missing',
      headers: { authorization: 'Bearer tok-7', cookie: 'sid=s-8' },
    });

    expect(log.lines.length).toBeGreaterThan(0);
    const output = log.lines.join('\n');
    expect(output).not.toContain('tok-7');
    expect(output).not.toContain('s-8');
  });
});
