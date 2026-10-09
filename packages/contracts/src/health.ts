import { z } from 'zod';

/** `GET /health`: liveness. The process is up and serving HTTP; no dependency is checked. */
export const HealthResponseSchema = z.object({
  status: z.literal('ok'),
});

export type HealthResponse = z.infer<typeof HealthResponseSchema>;

/** Status vocabulary borrowed from the IETF "Health Check Response Format for HTTP APIs" draft. */
export const CheckStatusSchema = z.enum(['pass', 'fail']);

export type CheckStatus = z.infer<typeof CheckStatusSchema>;

export const ReadinessCheckSchema = z.object({
  status: CheckStatusSchema,
  durationMs: z.number().nonnegative(),
  /** Short, non-sensitive explanation, present when the check fails. */
  output: z.string().optional(),
});

export type ReadinessCheck = z.infer<typeof ReadinessCheckSchema>;

/**
 * `GET /ready`: readiness. `status` is `pass` only when every check passes
 * (HTTP 200); otherwise `fail` (HTTP 503). Checks are keyed by name, e.g. `database`.
 */
export const ReadyResponseSchema = z.object({
  status: CheckStatusSchema,
  checks: z.record(z.string().min(1), ReadinessCheckSchema),
});

export type ReadyResponse = z.infer<typeof ReadyResponseSchema>;
