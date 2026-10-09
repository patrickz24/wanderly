import { z } from 'zod';

/**
 * Stable, machine-readable error codes returned by the API.
 * Clients branch on `code`; `message` is human-readable and may change.
 */
export const ApiErrorCodeSchema = z.enum([
  'VALIDATION_ERROR',
  'NOT_FOUND',
  'RATE_LIMITED',
  'BUDGET_EXCEEDED',
  'LLM_TIMEOUT',
  'PROVIDER_UNAVAILABLE',
  'INVALID_OUTPUT',
  'INTERNAL_ERROR',
]);

export type ApiErrorCode = z.infer<typeof ApiErrorCodeSchema>;

/** Const object view of the codes, e.g. `ApiErrorCode.NOT_FOUND`. */
export const ApiErrorCode = ApiErrorCodeSchema.enum;

/** Every error response body has this shape, whatever the HTTP status. */
export const ApiErrorResponseSchema = z.object({
  error: z.object({
    code: ApiErrorCodeSchema,
    message: z.string().min(1),
    /** Correlates the response with server logs and traces. */
    requestId: z.string().min(1).optional(),
  }),
});

export type ApiErrorResponse = z.infer<typeof ApiErrorResponseSchema>;
