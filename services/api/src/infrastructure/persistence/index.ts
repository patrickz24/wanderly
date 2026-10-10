import type pg from 'pg';
import type { ConversationRepository } from '../../application/ports/conversations.js';
import type {
  FeedbackRepository,
  RunRepository,
  SpendLedger,
} from '../../application/ports/runs.js';
import type { UnitOfWork } from '../../application/ports/unit-of-work.js';
import { poolDatabase, type Database } from './database.js';
import { PgConversationRepository } from './pg-conversation-repository.js';
import { PgFeedbackRepository, PgRunRepository, PgSpendLedger } from './pg-run-repository.js';

export interface Persistence {
  readonly conversations: ConversationRepository;
  readonly runs: RunRepository;
  readonly feedback: FeedbackRepository;
  readonly ledger: SpendLedger;
  readonly unitOfWork: UnitOfWork;
}

export function createPgUnitOfWork(db: Database): UnitOfWork {
  return {
    inTransaction: (work) =>
      db.transaction((tx) =>
        work({ conversations: new PgConversationRepository(tx), runs: new PgRunRepository(tx) }),
      ),
  };
}

/** Every persistence port, backed by one Postgres pool. */
export function createPgPersistence(pool: pg.Pool): Persistence {
  const db = poolDatabase(pool);
  return {
    conversations: new PgConversationRepository(db),
    runs: new PgRunRepository(db),
    feedback: new PgFeedbackRepository(db),
    ledger: new PgSpendLedger(db),
    unitOfWork: createPgUnitOfWork(db),
  };
}
