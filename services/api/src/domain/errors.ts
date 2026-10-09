/**
 * Typed domain errors.
 *
 * Messages and `details` are for developers and logs only. They may contain
 * internal information and are never sent to clients: the HTTP layer maps each
 * `code` to a status and a curated public message.
 */

export type DomainErrorCode =
  'NOT_FOUND' | 'BUDGET_EXCEEDED' | 'LLM_TIMEOUT' | 'PROVIDER_UNAVAILABLE' | 'INVALID_OUTPUT';

export type ErrorDetails = Readonly<Record<string, unknown>>;

export abstract class DomainError extends Error {
  abstract readonly code: DomainErrorCode;
  /** Structured context for logs and traces (never serialized to clients). */
  readonly details: ErrorDetails;

  protected constructor(message: string, details: ErrorDetails, options?: ErrorOptions) {
    super(message, options);
    this.name = new.target.name;
    this.details = Object.freeze({ ...details });
  }
}

/** A requested entity (conversation, run…) does not exist or is not visible to the caller. */
export class NotFoundError extends DomainError {
  readonly code = 'NOT_FOUND';

  constructor(
    readonly resource: string,
    readonly id: string,
  ) {
    super(`${resource} ${id} not found`, { resource, id });
  }
}

/** The global daily LLM spending cap is reached; checked before any LLM call. */
export class BudgetExceededError extends DomainError {
  readonly code = 'BUDGET_EXCEEDED';

  constructor(
    readonly spentUsd: number,
    readonly limitUsd: number,
  ) {
    super(`Daily budget exceeded: spent ${spentUsd} USD of ${limitUsd} USD`, {
      spentUsd,
      limitUsd,
    });
  }
}

/** An LLM call or the whole agent run exceeded its deadline. */
export class LlmTimeoutError extends DomainError {
  readonly code = 'LLM_TIMEOUT';

  constructor(
    readonly timeoutMs: number,
    options?: ErrorOptions,
  ) {
    super(`LLM call timed out after ${timeoutMs} ms`, { timeoutMs }, options);
  }
}

/** The LLM provider is unreachable or overloaded (429/5xx/529 after SDK retries). */
export class ProviderUnavailableError extends DomainError {
  readonly code = 'PROVIDER_UNAVAILABLE';

  constructor(
    readonly provider: string,
    options?: ErrorOptions & { readonly status?: number },
  ) {
    const status = options?.status;
    super(
      status === undefined
        ? `LLM provider ${provider} is unavailable`
        : `LLM provider ${provider} is unavailable (HTTP ${status})`,
      status === undefined ? { provider } : { provider, status },
      options,
    );
  }
}

/** The model output failed schema or semantic validation, including after the repair attempt. */
export class InvalidOutputError extends DomainError {
  readonly code = 'INVALID_OUTPUT';
  readonly issues: readonly string[];

  constructor(issues: readonly string[], options?: ErrorOptions) {
    super(`Model output is invalid: ${issues.length} issue(s)`, { issues: [...issues] }, options);
    this.issues = Object.freeze([...issues]);
  }
}

/** Closed union of every concrete domain error: `switch (error.code)` narrows to the class. */
export type KnownDomainError =
  | NotFoundError
  | BudgetExceededError
  | LlmTimeoutError
  | ProviderUnavailableError
  | InvalidOutputError;

export function isDomainError(value: unknown): value is KnownDomainError {
  return value instanceof DomainError;
}
