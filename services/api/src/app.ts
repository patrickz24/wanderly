import { randomUUID } from 'node:crypto';
import type { IncomingMessage } from 'node:http';
import fastifyCookie from '@fastify/cookie';
import fastifyCors from '@fastify/cors';
import fastifyHelmet from '@fastify/helmet';
import fastifyRateLimit from '@fastify/rate-limit';
import Fastify from 'fastify';
import {
  serializerCompiler,
  validatorCompiler,
  type ZodTypeProvider,
} from 'fastify-type-provider-zod';
import { ROUTE_NOT_FOUND_MESSAGE, HttpError, errorBody, mapError } from './api/errors.js';
import { buildLoggerOptions, type LogDestination } from './api/logger.js';
import { conversationRoutes, type ConversationUseCases } from './api/routes/conversations.js';
import { healthRoutes } from './api/routes/health.js';
import type { ReadinessProbe } from './application/ports/readiness.js';
import type { Config } from './config.js';

/** What the conversation API needs; omitted only by tests of the platform routes. */
export interface ApiDependencies {
  readonly useCases: ConversationUseCases;
  /** SSE heartbeat period (tests shorten it). */
  readonly sseHeartbeatMs?: number;
}

export interface AppDependencies {
  readonly config: Config;
  readonly readinessProbe: ReadinessProbe;
  readonly api?: ApiDependencies;
  /** Log destination override (tests capture logs in memory). Defaults to stdout. */
  readonly logDestination?: LogDestination;
}

export type App = Awaited<ReturnType<typeof buildApp>>;

/** Chat payloads are small; a low limit bounds memory use per request. */
export const BODY_LIMIT_BYTES = 64 * 1024;
const REQUEST_ID_HEADER = 'x-request-id';
const REQUEST_ID_PATTERN = /^[\w.:-]{1,128}$/;

/**
 * Reuses a well-formed upstream request id (e.g. set by the reverse proxy) so
 * logs correlate across hops; anything else is replaced to prevent log injection.
 */
export function requestIdFrom(request: Pick<IncomingMessage, 'headers'>): string {
  const incoming = request.headers[REQUEST_ID_HEADER];
  return typeof incoming === 'string' && REQUEST_ID_PATTERN.test(incoming)
    ? incoming
    : randomUUID();
}

/**
 * Builds the HTTP application. Every external dependency is injected, so tests
 * exercise the real app with fakes through `app.inject()`.
 */
export async function buildApp({ config, readinessProbe, api, logDestination }: AppDependencies) {
  const app = Fastify({
    logger: buildLoggerOptions(config.logLevel, config.env, logDestination),
    trustProxy:
      typeof config.server.trustProxy === 'boolean'
        ? config.server.trustProxy
        : [...config.server.trustProxy],
    genReqId: requestIdFrom,
    bodyLimit: BODY_LIMIT_BYTES,
    // Time allowed to receive a full request (slow-client protection); does not cap responses.
    requestTimeout: 30_000,
  }).withTypeProvider<ZodTypeProvider>();

  app.setValidatorCompiler(validatorCompiler);
  app.setSerializerCompiler(serializerCompiler);

  app.addHook('onRequest', async (request, reply) => {
    reply.header(REQUEST_ID_HEADER, request.id);
    // API responses are per-user and dynamic: never cache them anywhere.
    reply.header('cache-control', 'no-store');
  });

  await app.register(fastifyHelmet, {
    // The API only serves JSON: forbid every resource type, framing and form posts.
    contentSecurityPolicy: {
      useDefaults: false,
      directives: {
        defaultSrc: ["'none'"],
        baseUri: ["'none'"],
        formAction: ["'none'"],
        frameAncestors: ["'none'"],
      },
    },
    crossOriginEmbedderPolicy: true,
    frameguard: { action: 'deny' },
    referrerPolicy: { policy: 'no-referrer' },
  });

  await app.register(fastifyCors, {
    origin: [...config.server.corsOrigins],
    credentials: true,
    methods: ['GET', 'HEAD', 'POST'],
    allowedHeaders: ['Content-Type', 'X-Request-Id'],
    exposedHeaders: ['X-Request-Id', 'Retry-After'],
    maxAge: 600,
  });

  await app.register(fastifyCookie, {
    secret: config.session.secret.reveal(),
    parseOptions: {
      httpOnly: true,
      sameSite: 'lax',
      secure: config.env === 'production',
      path: '/',
    },
  });

  // Opt-in per route: `{ config: { rateLimit: {} } }` applies these defaults
  // (in-memory store, keyed by client IP as resolved through trustProxy).
  await app.register(fastifyRateLimit, {
    global: false,
    max: config.rateLimit.max,
    timeWindow: config.rateLimit.windowMs,
    errorResponseBuilder: (_request, context) =>
      new HttpError(
        context.statusCode,
        'RATE_LIMITED',
        `Too many requests. Please retry in ${context.after}.`,
      ),
  });

  app.setErrorHandler((error, request, reply) => {
    const { statusCode, body, logLevel } = mapError(error, request.id);
    request.log[logLevel]({ err: error, statusCode }, 'request failed');
    return reply.code(statusCode).send(body);
  });

  app.setNotFoundHandler((request, reply) =>
    reply.code(404).send(errorBody('NOT_FOUND', ROUTE_NOT_FOUND_MESSAGE, request.id)),
  );

  await app.register(healthRoutes, { readinessProbe, logLevel: config.logLevel });

  if (api !== undefined) {
    await app.register(conversationRoutes, {
      prefix: '/api',
      useCases: api.useCases,
      apiRateLimit: { max: config.apiRateLimit.max, timeWindow: config.apiRateLimit.windowMs },
      secureCookies: config.env === 'production',
      ...(api.sseHeartbeatMs === undefined ? {} : { sseHeartbeatMs: api.sseHeartbeatMs }),
    });
  }

  return app;
}
