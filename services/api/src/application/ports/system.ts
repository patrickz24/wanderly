/** Generates unique identifiers (UUID v4 in production, predictable sequences in tests). */
export interface IdGenerator {
  newId(): string;
}

/**
 * Structured logger handed to a use case per request (pino-compatible), so its records carry the
 * request id. Used for problems that must not fail the request.
 */
export interface UseCaseLogger {
  warn(details: Record<string, unknown>, message: string): void;
  error(details: Record<string, unknown>, message: string): void;
}

export const SILENT_LOGGER: UseCaseLogger = Object.freeze({
  warn: () => undefined,
  error: () => undefined,
});
