import { inspect } from 'node:util';
import { describe, expect, it } from 'vitest';
import {
  ConfigError,
  Secret,
  deriveCanaryToken,
  loadConfig,
  loadLangfuseConfig,
} from './config.js';

const SESSION_SECRET = 'test-session-secret-0123456789abcdef';
const DATABASE_URL = 'postgres://wanderly:s3cr3t-db-password@localhost:5432/wanderly';

const minimalEnv = { DATABASE_URL, SESSION_SECRET };

const configError = (env: Record<string, string | undefined>): ConfigError => {
  try {
    loadConfig(env);
  } catch (error) {
    if (error instanceof ConfigError) return error;
    throw error;
  }
  throw new Error('expected loadConfig to throw');
};

describe('loadConfig', () => {
  it('applies the documented defaults when only the required variables are set', () => {
    const config = loadConfig(minimalEnv);

    expect(config.env).toBe('development');
    expect(config.server).toEqual({
      host: '0.0.0.0',
      port: 3000,
      trustProxy: false,
      corsOrigins: ['http://localhost:5173', 'http://localhost:8080'],
    });
    expect(config.logLevel).toBe('info');
    expect(config.database.url.reveal()).toBe(DATABASE_URL);
    expect(config.session.secret.reveal()).toBe(SESSION_SECRET);
    expect(config.llm).toEqual({
      anthropicApiKey: undefined,
      model: 'claude-haiku-5-5',
      effort: 'medium',
      judgeModel: 'claude-sonnet-5-5',
      timeoutMs: 45_000,
    });
    expect(config.agent).toEqual({
      runDeadlineMs: 90_000,
      maxSteps: 8,
      maxRunCostUsd: undefined,
      canaryToken: expect.any(Secret),
    });
    expect(config.agent.canaryToken.reveal()).toBe(deriveCanaryToken(SESSION_SECRET));
    expect(config.budget).toEqual({ dailyUsd: 2 });
    expect(config.retention).toEqual({ days: 30 });
    expect(config.rateLimit).toEqual({ max: 10, windowMs: 600_000 });
    expect(config.apiRateLimit).toEqual({ max: 120, windowMs: 60_000 });
    expect(config.langfuse).toEqual({
      publicKey: undefined,
      secretKey: undefined,
      baseUrl: 'https://cloud.langfuse.com',
    });
    expect(config.embeddings).toEqual({
      model: 'Xenova/bge-small-en-v1.5',
      cacheDir: '.cache/models',
    });
  });

  it('parses and coerces explicit values', () => {
    const config = loadConfig({
      ...minimalEnv,
      NODE_ENV: 'production',
      HOST: '127.0.0.1',
      PORT: '8081',
      LOG_LEVEL: 'warn',
      CORS_ORIGINS: ' https://wanderly.example , http://localhost:5173 ,',
      ANTHROPIC_API_KEY: 'sk-ant-test',
      LLM_EFFORT: 'low',
      DAILY_BUDGET_USD: '0.5',
      RETENTION_DAYS: '7',
      RATE_LIMIT_MAX: '3',
      LANGFUSE_PUBLIC_KEY: 'pk-lf-test',
      LANGFUSE_SECRET_KEY: 'sk-lf-test',
    });

    expect(config.env).toBe('production');
    expect(config.server.host).toBe('127.0.0.1');
    expect(config.server.port).toBe(8081);
    expect(config.logLevel).toBe('warn');
    expect(config.server.corsOrigins).toEqual([
      'https://wanderly.example',
      'http://localhost:5173',
    ]);
    expect(config.llm.anthropicApiKey?.reveal()).toBe('sk-ant-test');
    expect(config.llm.effort).toBe('low');
    expect(config.budget.dailyUsd).toBe(0.5);
    expect(config.retention.days).toBe(7);
    expect(config.rateLimit.max).toBe(3);
    expect(config.langfuse.publicKey).toBe('pk-lf-test');
    expect(config.langfuse.secretKey?.reveal()).toBe('sk-lf-test');
  });

  it('treats blank variables as unset so that `KEY=` falls back to the default', () => {
    const config = loadConfig({ ...minimalEnv, PORT: '', ANTHROPIC_API_KEY: '   ' });
    expect(config.server.port).toBe(3000);
    expect(config.llm.anthropicApiKey).toBeUndefined();
  });

  it.each([
    ['false', false],
    ['true', true],
    ['10.0.0.0/8, 127.0.0.1', ['10.0.0.0/8', '127.0.0.1']],
    ['::1', ['::1']],
    ['loopback,uniquelocal', ['loopback', 'uniquelocal']],
  ])('parses TRUST_PROXY=%j', (value, expected) => {
    expect(loadConfig({ ...minimalEnv, TRUST_PROXY: value }).server.trustProxy).toEqual(expected);
  });

  it('returns a deeply frozen object', () => {
    const config = loadConfig(minimalEnv);
    expect(Object.isFrozen(config)).toBe(true);
    expect(Object.isFrozen(config.server)).toBe(true);
    expect(Object.isFrozen(config.server.corsOrigins)).toBe(true);
    expect(() => {
      (config.server as { port: number }).port = 1;
    }).toThrow(TypeError);
  });

  it('reports every missing required variable at once', () => {
    const error = configError({});
    expect(error.issues).toEqual(['DATABASE_URL: is required', 'SESSION_SECRET: is required']);
    expect(error.message).toBe(
      'Invalid environment configuration:\n  - DATABASE_URL: is required\n  - SESSION_SECRET: is required',
    );
  });

  it.each([
    ['PORT', '70000'],
    ['PORT', 'abc'],
    ['NODE_ENV', 'staging'],
    ['LOG_LEVEL', 'verbose'],
    ['LLM_EFFORT', 'extreme'],
    ['AGENT_MAX_STEPS', '0'],
    ['DAILY_BUDGET_USD', '-1'],
    ['RETENTION_DAYS', '0'],
    ['RETENTION_DAYS', '1.5'],
    ['RETENTION_DAYS', '3651'],
    ['RATE_LIMIT_WINDOW_MS', '1.5'],
    ['LANGFUSE_BASE_URL', 'ftp://langfuse.example'],
    ['CORS_ORIGINS', '*'],
    ['CORS_ORIGINS', 'https://wanderly.example/'],
    ['CORS_ORIGINS', 'wanderly.example'],
    ['TRUST_PROXY', 'yes please'],
    ['TRUST_PROXY', ','],
    ['TRUST_PROXY', '1'],
    ['DATABASE_URL', 'mysql://user:pass@localhost/db'],
    ['DATABASE_URL', 'not a url'],
  ])('rejects %s=%j', (key, value) => {
    const error = configError({ ...minimalEnv, [key]: value });
    expect(error.issues.length).toBeGreaterThan(0);
    expect(error.issues.every((issue) => issue.startsWith(`${key}: `))).toBe(true);
  });

  it('rejects a run deadline shorter than a single LLM call', () => {
    const error = configError({
      ...minimalEnv,
      LLM_TIMEOUT_MS: '60000',
      AGENT_RUN_DEADLINE_MS: '30000',
    });
    expect(error.issues).toEqual([
      'AGENT_RUN_DEADLINE_MS: must be greater than or equal to LLM_TIMEOUT_MS',
    ]);
  });

  it('requires both Langfuse keys or neither', () => {
    const error = configError({ ...minimalEnv, LANGFUSE_PUBLIC_KEY: 'pk-lf-only' });
    expect(error.issues).toEqual([
      'LANGFUSE_SECRET_KEY: LANGFUSE_PUBLIC_KEY and LANGFUSE_SECRET_KEY must be set together',
    ]);
  });

  it('never echoes secret values in validation errors', () => {
    const shortSecret = 'too-short-but-secret';
    const badUrl = 'mysql://admin:hunter2-password@db.internal/app';
    const error = configError({ DATABASE_URL: badUrl, SESSION_SECRET: shortSecret });

    expect(error.issues).toEqual([
      'DATABASE_URL: must be a postgres:// or postgresql:// URL with a host',
      'SESSION_SECRET: must be at least 32 characters (see .env.example to generate one)',
    ]);
    expect(error.message).not.toContain(shortSecret);
    expect(error.message).not.toContain('hunter2');
  });
});

describe('agent and API limits', () => {
  it('reads the per-run cost ceiling, an explicit canary and the API rate limit', () => {
    const config = loadConfig({
      ...minimalEnv,
      AGENT_MAX_RUN_COST_USD: '0.25',
      AGENT_CANARY_TOKEN: 'canary-from-env-0123',
      API_RATE_LIMIT_MAX: '30',
      API_RATE_LIMIT_WINDOW_MS: '1000',
    });

    expect(config.agent.maxRunCostUsd).toBe(0.25);
    expect(config.agent.canaryToken.reveal()).toBe('canary-from-env-0123');
    expect(config.apiRateLimit).toEqual({ max: 30, windowMs: 1_000 });
  });

  it('rejects a short canary and a non-positive cost ceiling, without echoing them', () => {
    const error = configError({
      ...minimalEnv,
      AGENT_CANARY_TOKEN: 'short-canary',
      AGENT_MAX_RUN_COST_USD: '0',
    });

    expect(error.issues).toEqual([
      expect.stringMatching(/^AGENT_MAX_RUN_COST_USD: /),
      'AGENT_CANARY_TOKEN: must contain at least 16 letters or digits',
    ]);
    expect(error.message).not.toContain('short-canary');
  });

  it('counts only letters and digits in the canary, like the leak detector', () => {
    const error = configError({ ...minimalEnv, AGENT_CANARY_TOKEN: 'abc-def-ghi-jkl-mn' });
    expect(error.issues).toEqual([
      'AGENT_CANARY_TOKEN: must contain at least 16 letters or digits',
    ]);
  });
});

describe('loadLangfuseConfig', () => {
  it('needs neither the database nor the session secret, and is off without keys', () => {
    expect(loadLangfuseConfig({ LANGFUSE_PUBLIC_KEY: ' ' })).toEqual({
      publicKey: undefined,
      secretKey: undefined,
      baseUrl: 'https://cloud.langfuse.com',
    });
  });

  it('reads both keys, the secret one wrapped, and a custom base URL', () => {
    const langfuse = loadLangfuseConfig({
      LANGFUSE_PUBLIC_KEY: 'pk-lf-eval',
      LANGFUSE_SECRET_KEY: 'sk-lf-eval',
      LANGFUSE_BASE_URL: 'https://us.cloud.langfuse.com',
    });
    expect(langfuse.publicKey).toBe('pk-lf-eval');
    expect(langfuse.secretKey?.reveal()).toBe('sk-lf-eval');
    expect(String(langfuse.secretKey)).toBe('[redacted]');
    expect(langfuse.baseUrl).toBe('https://us.cloud.langfuse.com');
  });

  it('applies the same rules as the API config, without echoing the key', () => {
    const attempt = () => loadLangfuseConfig({ LANGFUSE_SECRET_KEY: 'sk-lf-only' });
    expect(attempt).toThrow(ConfigError);
    expect(attempt).toThrow(
      'LANGFUSE_SECRET_KEY: LANGFUSE_PUBLIC_KEY and LANGFUSE_SECRET_KEY must be set together',
    );
    expect(attempt).not.toThrow(/sk-lf-only/);
    expect(() => loadLangfuseConfig({ LANGFUSE_BASE_URL: 'ftp://langfuse.example' })).toThrow(
      /LANGFUSE_BASE_URL: /,
    );
  });
});

describe('deriveCanaryToken', () => {
  it('is stable for a secret, differs across secrets and does not contain the secret', () => {
    const canary = deriveCanaryToken(SESSION_SECRET);

    expect(canary).toMatch(/^cnry-[A-Za-z0-9_-]{24}$/);
    expect(deriveCanaryToken(SESSION_SECRET)).toBe(canary);
    expect(deriveCanaryToken(`${SESSION_SECRET}x`)).not.toBe(canary);
    expect(canary).not.toContain(SESSION_SECRET.slice(0, 8));
  });
});

describe('Secret', () => {
  const secret = new Secret('sk-very-secret');

  it('reveals the value only on explicit request', () => {
    expect(secret.reveal()).toBe('sk-very-secret');
  });

  it('is redacted when stringified, serialized or inspected', () => {
    expect(String(secret)).toBe('[redacted]');
    expect(`${secret}`).toBe('[redacted]');
    expect(JSON.stringify({ apiKey: secret })).toBe('{"apiKey":"[redacted]"}');
    expect(inspect({ apiKey: secret })).not.toContain('sk-very-secret');
  });

  it('keeps the whole config free of secret values when serialized', () => {
    const config = loadConfig({
      ...minimalEnv,
      ANTHROPIC_API_KEY: 'sk-ant-should-not-leak',
      LANGFUSE_PUBLIC_KEY: 'pk-lf-public',
      LANGFUSE_SECRET_KEY: 'sk-lf-should-not-leak',
    });
    const dump = `${JSON.stringify(config)}\n${inspect(config, { depth: null })}`;

    for (const value of [
      SESSION_SECRET,
      's3cr3t-db-password',
      'sk-ant-should-not-leak',
      'sk-lf-should-not-leak',
    ]) {
      expect(dump).not.toContain(value);
    }
  });
});
