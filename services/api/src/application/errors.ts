/**
 * Errors raised by use cases when a request breaks an application rule. Like domain errors, their
 * messages are for logs; the HTTP layer maps each `code` to a status and a curated message.
 */

export type ApplicationErrorCode = 'TURN_LIMIT_REACHED' | 'CONVERSATION_BUSY';

export abstract class ApplicationError extends Error {
  abstract readonly code: ApplicationErrorCode;

  protected constructor(message: string) {
    super(message);
    this.name = new.target.name;
  }
}

/** The conversation already holds the maximum number of user turns (no compaction in the MVP). */
export class TurnLimitReachedError extends ApplicationError {
  readonly code = 'TURN_LIMIT_REACHED';

  constructor(
    readonly conversationId: string,
    readonly limit: number,
  ) {
    super(`Conversation ${conversationId} reached its limit of ${limit} turns`);
  }
}

/** A reply is still being generated for this conversation (one run at a time per conversation). */
export class ConversationBusyError extends ApplicationError {
  readonly code = 'CONVERSATION_BUSY';

  constructor(readonly conversationId: string) {
    super(`Conversation ${conversationId} already has a run in progress`);
  }
}

export type KnownApplicationError = TurnLimitReachedError | ConversationBusyError;

export function isApplicationError(value: unknown): value is KnownApplicationError {
  return value instanceof ApplicationError;
}
