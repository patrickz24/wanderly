import {
  HealthResponseSchema,
  ReadyResponseSchema,
  type HealthResponse,
  type ReadinessCheck,
  type ReadyResponse,
} from '@wanderly/contracts';
import type { FastifyBaseLogger } from 'fastify';
import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import type { ReadinessProbe, ReadinessReport } from '../../application/ports/readiness.js';
import type { LogLevel } from '../../config.js';

export interface HealthRoutesOptions {
  readonly readinessProbe: ReadinessProbe;
  /** The application log level; probe routes never log below `warn`. */
  readonly logLevel: LogLevel;
}

const SEVERITY: Readonly<Record<LogLevel, number>> = {
  trace: 10,
  debug: 20,
  info: 30,
  warn: 40,
  error: 50,
  fatal: 60,
  silent: Number.POSITIVE_INFINITY,
};

/**
 * Probes are polled every few seconds by orchestrators, so their request logs
 * are raised to `warn` (only failures are visible). A route level replaces the
 * logger level, so it must never be less severe than the configured one.
 */
export function probeLogLevel(configured: LogLevel): LogLevel {
  return SEVERITY[configured] > SEVERITY.warn ? configured : 'warn';
}

export const healthRoutes: FastifyPluginAsyncZod<HealthRoutesOptions> = async (
  app,
  { readinessProbe, logLevel: configured },
) => {
  const logLevel = probeLogLevel(configured);

  app.get(
    '/health',
    { logLevel, schema: { response: { 200: HealthResponseSchema } } },
    async (): Promise<HealthResponse> => ({ status: 'ok' }),
  );

  app.get(
    '/ready',
    {
      logLevel,
      schema: { response: { 200: ReadyResponseSchema, 503: ReadyResponseSchema } },
    },
    async (request, reply) => {
      const report = await readinessProbe.check();
      logFailedChecks(report, request.log);
      return reply.code(report.status === 'pass' ? 200 : 503).send(toReadyResponse(report));
    },
  );
};

/** Keeps only public fields: internal `detail` is logged, never returned. */
export function toReadyResponse(report: ReadinessReport): ReadyResponse {
  const checks: Record<string, ReadinessCheck> = {};
  for (const [name, { status, durationMs, output }] of Object.entries(report.checks)) {
    checks[name] = output === undefined ? { status, durationMs } : { status, durationMs, output };
  }
  return { status: report.status, checks };
}

function logFailedChecks(report: ReadinessReport, log: FastifyBaseLogger): void {
  for (const [check, result] of Object.entries(report.checks)) {
    if (result.status === 'pass') continue;
    const context =
      result.detail instanceof Error
        ? { check, output: result.output, err: result.detail }
        : { check, output: result.output, detail: result.detail };
    log.warn(context, 'readiness check failed');
  }
}
