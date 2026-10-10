import { createHmac } from 'node:crypto';
import { inspect } from 'node:util';
import { z } from 'zod';

/**
 * Wraps a secret so that it cannot leak by accident: string conversion, JSON
 * serialization (pino logs) and `util.inspect` all print a placeholder.
 * Call `reveal()` only where the raw value is handed to a client library.
 */
export class Secret {
  readonly #value: string;

  constructor(value: string) {
    this.#value = value;
  }

  reveal(): string {
    return this.#value;
  }

  toString(): string {
    return '[redacted]';
  }

  toJSON(): string {
    return '[redacted]';
  }

  [inspect.custom](): string {
    return 'Secret([redacted])';
  }
}

const LOG_LEVELS = ['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent'] as const;
const LLM_EFFORTS = ['low', 'medium', 'high', 'xhigh', 'max'] as const;
const NODE_ENVS = ['development', 'test', 'production'] as const;

export type NodeEnv = (typeof NODE_ENVS)[number];
export type LogLevel = (typeof LOG_LEVELS)[number];
export type LlmEffort = (typeof LLM_EFFORTS)[number];
/** `false`, `true`, or the trusted proxy IPs/CIDRs (Fastify `trustProxy`). */
export type TrustProxy = boolean | readonly string[];

export const DEFAULT_CORS_ORIGINS = 'http://localhost:5173,http://localhost:8080';
export const MIN_SESSION_SECRET_LENGTH = 32;
export const MIN_CANARY_TOKEN_LENGTH = 16;

export interface Config {
  readonly env: NodeEnv;
  readonly server: {
    readonly host: string;
    readonly port: number;
    readonly trustProxy: TrustProxy;
    readonly corsOrigins: readonly string[];
  };
  readonly logLevel: LogLevel;
  readonly database: { readonly url: Secret };
  readonly session: { readonly secret: Secret };
  readonly llm: {
    readonly anthropicApiKey: Secret | undefined;
    readonly model: string;
    readonly effort: LlmEffort;
    readonly judgeModel: string;
    readonly timeoutMs: number;
  };
  readonly agent: {
    readonly runDeadlineMs: number;
    readonly maxSteps: number;
    /** Per-run cost ceiling; undefined = the runtime's default. */
    readonly maxRunCostUsd: number | undefined;
    /** System prompt canary (leak detection), stable across restarts. */
    readonly canaryToken: Secret;
  };
  readonly budget: { readonly dailyUsd: number };
  /** Per-IP limit of the message route (each message starts a paid agent run). */
  readonly rateLimit: { readonly max: number; readonly windowMs: number };
  /** Looser per-IP limit of the other API routes. */
  readonly apiRateLimit: { readonly max: number; readonly windowMs: number };
  readonly langfuse: {
    readonly publicKey: string | undefined;
    readonly secretKey: Secret | undefined;
    readonly baseUrl: string;
  };
  readonly embeddings: { readonly model: string; readonly cacheDir: string };
}

export class ConfigError extends Error {
  constructor(readonly issues: readonly string[]) {
    super(
      ['Invalid environment configuration:', ...issues.map((issue) => `  - ${issue}`)].join('\n'),
    );
    this.name = 'ConfigError';
  }
}

const positiveInt = z.coerce.number().int().positive();

function isPostgresUrl(value: string): boolean {
  if (!URL.canParse(value)) return false;
  const { protocol, hostname } = new URL(value);
  return (protocol === 'postgres:' || protocol === 'postgresql:') && hostname !== '';
}

function isHttpOrigin(value: string): boolean {
  if (!URL.canParse(value)) return false;
  const url = new URL(value);
  return (url.protocol === 'http:' || url.protocol === 'https:') && url.origin === value;
}

const corsOrigins = z
  .string()
  .transform((value) =>
    value
      .split(',')
      .map((origin) => origin.trim())
      .filter((origin) => origin !== ''),
  )
  .superRefine((origins, ctx) => {
    for (const origin of origins.filter((candidate) => !isHttpOrigin(candidate))) {
      // Origins are public values, so echoing them helps fix the typo.
      ctx.addIssue({
        code: 'custom',
        message: `"${origin}" is not an origin (expected scheme://host[:port], no path, no wildcard)`,
      });
    }
  });

const TRUST_PROXY_PRESETS = new Set(['loopback', 'linklocal', 'uniquelocal']);

const isProxyAddress = (entry: string): boolean =>
  TRUST_PROXY_PRESETS.has(entry) || (/^[\da-fA-F.:/]+$/.test(entry) && !/^\d+$/.test(entry));

/**
 * Fastify 5 deliberately ignores hop counts (they cannot authenticate the peer),
 * so only booleans and explicit proxy addresses are accepted.
 */
const trustProxy = z.string().transform((value, ctx): TrustProxy => {
  if (value === 'true') return true;
  if (value === 'false') return false;
  const entries = value
    .split(',')
    .map((entry) => entry.trim())
    .filter((entry) => entry !== '');
  if (entries.length === 0 || !entries.every(isProxyAddress)) {
    ctx.addIssue({
      code: 'custom',
      message:
        'must be true, false, or a comma-separated list of proxy IPs/CIDRs (loopback, linklocal and uniquelocal are accepted)',
    });
    return z.NEVER;
  }
  return entries;
});

/**
 * Raw environment contract. Only DATABASE_URL and SESSION_SECRET are required at
 * milestone 1; variables used by later milestones are optional or defaulted.
 * Custom messages never include the received value (it may be a secret).
 */
const EnvSchema = z
  .object({
    NODE_ENV: z.enum(NODE_ENVS).default('development'),
    HOST: z.string().default('0.0.0.0'),
    PORT: positiveInt.max(65_535).default(3000),
    LOG_LEVEL: z.enum(LOG_LEVELS).default('info'),
    DATABASE_URL: z
      .string({ error: 'is required' })
      .refine(isPostgresUrl, 'must be a postgres:// or postgresql:// URL with a host'),
    CORS_ORIGINS: corsOrigins.prefault(DEFAULT_CORS_ORIGINS),
    TRUST_PROXY: trustProxy.default(false),
    SESSION_SECRET: z
      .string({ error: 'is required' })
      .min(
        MIN_SESSION_SECRET_LENGTH,
        `must be at least ${MIN_SESSION_SECRET_LENGTH} characters (see .env.example to generate one)`,
      ),
    ANTHROPIC_API_KEY: z.string().optional(),
    LLM_MODEL: z.string().default('claude-haiku-5-5'),
    LLM_EFFORT: z.enum(LLM_EFFORTS).default('medium'),
    JUDGE_MODEL: z.string().default('claude-sonnet-5-5'),
    LLM_TIMEOUT_MS: positiveInt.default(45_000),
    AGENT_RUN_DEADLINE_MS: positiveInt.default(90_000),
    AGENT_MAX_STEPS: positiveInt.max(50).default(8),
    AGENT_MAX_RUN_COST_USD: z.coerce.number().positive().max(10).optional(),
    AGENT_CANARY_TOKEN: z
      .string()
      .min(MIN_CANARY_TOKEN_LENGTH, `must be at least ${MIN_CANARY_TOKEN_LENGTH} characters`)
      .optional(),
    DAILY_BUDGET_USD: z.coerce.number().nonnegative().max(1_000).default(2),
    RATE_LIMIT_MAX: positiveInt.default(10),
    RATE_LIMIT_WINDOW_MS: positiveInt.default(600_000),
    API_RATE_LIMIT_MAX: positiveInt.default(120),
    API_RATE_LIMIT_WINDOW_MS: positiveInt.default(60_000),
    LANGFUSE_PUBLIC_KEY: z.string().optional(),
    LANGFUSE_SECRET_KEY: z.string().optional(),
    LANGFUSE_BASE_URL: z.url({ protocol: /^https?$/ }).default('https://cloud.langfuse.com'),
    EMBEDDING_MODEL: z.string().default('Xenova/bge-small-en-v1.5'),
    EMBEDDING_CACHE_DIR: z.string().default('.cache/models'),
  })
  .superRefine((env, ctx) => {
    if (env.AGENT_RUN_DEADLINE_MS < env.LLM_TIMEOUT_MS) {
      ctx.addIssue({
        code: 'custom',
        path: ['AGENT_RUN_DEADLINE_MS'],
        message: 'must be greater than or equal to LLM_TIMEOUT_MS',
      });
    }
    if ((env.LANGFUSE_PUBLIC_KEY === undefined) !== (env.LANGFUSE_SECRET_KEY === undefined)) {
      ctx.addIssue({
        code: 'custom',
        path: ['LANGFUSE_SECRET_KEY'],
        message: 'LANGFUSE_PUBLIC_KEY and LANGFUSE_SECRET_KEY must be set together',
      });
    }
  });

type Env = z.output<typeof EnvSchema>;

/** Drops unset and blank variables so that `KEY=` in a .env file means "use the default". */
function normalize(env: Readonly<Record<string, string | undefined>>): Record<string, string> {
  const entries: Array<[string, string]> = [];
  for (const [key, value] of Object.entries(env)) {
    const trimmed = value?.trim();
    if (trimmed !== undefined && trimmed !== '') entries.push([key, trimmed]);
  }
  return Object.fromEntries(entries);
}

const optionalSecret = (value: string | undefined): Secret | undefined =>
  value === undefined ? undefined : new Secret(value);

function toConfig(env: Env): Config {
  return {
    env: env.NODE_ENV,
    server: {
      host: env.HOST,
      port: env.PORT,
      trustProxy: env.TRUST_PROXY,
      corsOrigins: env.CORS_ORIGINS,
    },
    logLevel: env.LOG_LEVEL,
    database: { url: new Secret(env.DATABASE_URL) },
    session: { secret: new Secret(env.SESSION_SECRET) },
    llm: {
      anthropicApiKey: optionalSecret(env.ANTHROPIC_API_KEY),
      model: env.LLM_MODEL,
      effort: env.LLM_EFFORT,
      judgeModel: env.JUDGE_MODEL,
      timeoutMs: env.LLM_TIMEOUT_MS,
    },
    agent: {
      runDeadlineMs: env.AGENT_RUN_DEADLINE_MS,
      maxSteps: env.AGENT_MAX_STEPS,
      maxRunCostUsd: env.AGENT_MAX_RUN_COST_USD,
      canaryToken: new Secret(env.AGENT_CANARY_TOKEN ?? deriveCanaryToken(env.SESSION_SECRET)),
    },
    budget: { dailyUsd: env.DAILY_BUDGET_USD },
    rateLimit: { max: env.RATE_LIMIT_MAX, windowMs: env.RATE_LIMIT_WINDOW_MS },
    apiRateLimit: { max: env.API_RATE_LIMIT_MAX, windowMs: env.API_RATE_LIMIT_WINDOW_MS },
    langfuse: {
      publicKey: env.LANGFUSE_PUBLIC_KEY,
      secretKey: optionalSecret(env.LANGFUSE_SECRET_KEY),
      baseUrl: env.LANGFUSE_BASE_URL,
    },
    embeddings: { model: env.EMBEDDING_MODEL, cacheDir: env.EMBEDDING_CACHE_DIR },
  };
}

/**
 * Default canary: derived from SESSION_SECRET with a domain-separated HMAC, so it is secret,
 * stable across restarts (the system prompt prefix stays cacheable) and needs no extra variable.
 */
export function deriveCanaryToken(sessionSecret: string): string {
  const digest = createHmac('sha256', sessionSecret)
    .update('wanderly/system-prompt-canary/v1')
    .digest('base64url');
  return `cnry-${digest.slice(0, 24)}`;
}

function deepFreeze<T>(value: T): T {
  if (typeof value === 'object' && value !== null && !(value instanceof Secret)) {
    for (const nested of Object.values(value)) deepFreeze(nested);
    Object.freeze(value);
  }
  return value;
}

/**
 * Validates the environment once at startup and returns an immutable, typed config.
 * Throws a ConfigError listing every problem (variable names and rules, never values).
 */
export function loadConfig(
  env: Readonly<Record<string, string | undefined>> = process.env,
): Config {
  const result = EnvSchema.safeParse(normalize(env));
  if (!result.success) {
    const issues = result.error.issues.map((issue) => {
      const key = issue.path.length > 0 ? issue.path.map(String).join('.') : '(root)';
      return `${key}: ${issue.message}`;
    });
    throw new ConfigError(issues);
  }
  return deepFreeze(toConfig(result.data));
}
