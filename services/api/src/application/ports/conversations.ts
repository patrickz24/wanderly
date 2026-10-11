import type {
  AgentResponse,
  RunStats,
  SourceSummary,
  ToolCallSummary,
  TripBrief,
} from '@wanderly/contracts';
import type { LlmMessage } from '../../domain/ports/llm.js';

/** A conversation as stored; `sessionId` is the anonymous browser session that owns it. */
export interface Conversation {
  readonly id: string;
  readonly sessionId: string;
  readonly title: string | null;
  /** Structured memory carried from turn to turn. */
  readonly brief: TripBrief;
  readonly createdAt: Date;
  readonly updatedAt: Date;
}

/** Display data of one completed turn: the user's text and the run that answered it. */
export interface ConversationTurn {
  readonly runId: string;
  readonly userMessageId: string;
  readonly userText: string;
  readonly userCreatedAt: Date;
  /** Id of the assistant message holding the answer (the run id when there is none). */
  readonly assistantMessageId: string;
  readonly response: AgentResponse;
  readonly sources: readonly SourceSummary[];
  readonly toolCalls: readonly ToolCallSummary[];
  readonly completedAt: Date;
  /** Measured figures of the run, shown in the message footer. */
  readonly run: RunStats;
  /** The session's rating of the run, if given. */
  readonly feedbackRating: 1 | -1 | null;
}

/** A message to append to the replayable history, with its id and provenance. */
export interface NewMessage {
  readonly id: string;
  readonly message: LlmMessage;
  /** Adapter and model that produced an assistant message; null for user messages. */
  readonly provider: string | null;
  readonly model: string | null;
  readonly createdAt: Date;
}

export interface ConversationUpdate {
  readonly brief: TripBrief;
  /** Applied only while the conversation has no title yet. */
  readonly titleIfUnset: string;
  readonly updatedAt: Date;
}

export interface ConversationRepository {
  create(conversation: {
    readonly id: string;
    readonly sessionId: string;
    readonly brief: TripBrief;
    readonly now: Date;
  }): Promise<Conversation>;

  /** Most recently updated first. */
  listForSession(sessionId: string, limit: number): Promise<readonly Conversation[]>;

  /**
   * Null when the conversation does not exist or belongs to another session: callers cannot
   * tell the two apart, so a session cannot probe other sessions' ids.
   */
  findForSession(id: string, sessionId: string): Promise<Conversation | null>;

  /** Completed turns, oldest first. */
  listTurns(conversationId: string): Promise<readonly ConversationTurn[]>;

  /** Number of completed turns (successful runs). */
  countCompletedTurns(conversationId: string): Promise<number>;

  /** The replayable history, in order, exactly as appended. */
  loadHistory(conversationId: string): Promise<readonly LlmMessage[]>;

  /**
   * Appends messages after the last one, with consecutive sequence numbers, atomically.
   * Stored messages are never modified (append-only history).
   */
  appendMessages(conversationId: string, messages: readonly NewMessage[]): Promise<void>;

  updateAfterTurn(conversationId: string, update: ConversationUpdate): Promise<void>;

  /**
   * Moves `updatedAt` forward to `at` (never back) when a run starts, so the retention purge
   * cannot delete the conversation while the run is in progress. Throws `NotFoundError` when the
   * conversation no longer exists (purged since it was loaded).
   */
  markActive(conversationId: string, at: Date): Promise<void>;
}
