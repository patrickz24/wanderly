import type { ConversationRepository } from './conversations.js';
import type { RunRepository } from './runs.js';

export interface TransactionalRepositories {
  readonly conversations: ConversationRepository;
  readonly runs: RunRepository;
}

/**
 * Runs `work` in one database transaction: everything it writes through the given repositories
 * is committed together, or not at all when it throws.
 */
export interface UnitOfWork {
  inTransaction<T>(work: (repositories: TransactionalRepositories) => Promise<T>): Promise<T>;
}
