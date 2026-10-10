import {
  EMPTY_TRIP_BRIEF,
  type ConversationSummary,
  type GetConversationResponse,
  type ListConversationsResponse,
} from '@wanderly/contracts';
import { NotFoundError } from '../domain/errors.js';
import type { Clock } from '../domain/ports/tracer.js';
import { toConversationDetail, toConversationSummary } from './dto.js';
import type { ConversationRepository } from './ports/conversations.js';
import type { IdGenerator } from './ports/system.js';

/** The conversation list shows the most recent ones; older ones expire with retention. */
export const MAX_LISTED_CONVERSATIONS = 50;

export interface ConversationQueriesDeps {
  readonly conversations: ConversationRepository;
  readonly ids: IdGenerator;
  readonly clock: Clock;
}

export interface CreateConversation {
  execute(command: { readonly sessionId: string }): Promise<ConversationSummary>;
}

export interface ListConversations {
  execute(query: { readonly sessionId: string }): Promise<ListConversationsResponse>;
}

export interface GetConversation {
  /** Throws `NotFoundError` when the conversation is not one of the session's. */
  execute(query: {
    readonly sessionId: string;
    readonly conversationId: string;
  }): Promise<GetConversationResponse>;
}

export function createCreateConversation({
  conversations,
  ids,
  clock,
}: ConversationQueriesDeps): CreateConversation {
  return {
    async execute({ sessionId }) {
      const conversation = await conversations.create({
        id: ids.newId(),
        sessionId,
        brief: EMPTY_TRIP_BRIEF,
        now: clock.now(),
      });
      return toConversationSummary(conversation);
    },
  };
}

export function createListConversations({
  conversations,
}: Pick<ConversationQueriesDeps, 'conversations'>): ListConversations {
  return {
    async execute({ sessionId }) {
      const found = await conversations.listForSession(sessionId, MAX_LISTED_CONVERSATIONS);
      return { conversations: found.map(toConversationSummary) };
    },
  };
}

export function createGetConversation({
  conversations,
}: Pick<ConversationQueriesDeps, 'conversations'>): GetConversation {
  return {
    async execute({ sessionId, conversationId }) {
      const conversation = await conversations.findForSession(conversationId, sessionId);
      if (conversation === null) throw new NotFoundError('conversation', conversationId);
      const turns = await conversations.listTurns(conversation.id);
      return toConversationDetail(conversation, turns);
    },
  };
}
