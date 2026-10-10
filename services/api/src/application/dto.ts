import type {
  AgentResponse,
  AssistantMessage,
  ConversationMessage,
  ConversationSummary,
  GetConversationResponse,
  SourceSummary,
  ToolCallSummary,
} from '@wanderly/contracts';
import type { Conversation, ConversationTurn } from './ports/conversations.js';

/** Maps stored records to the HTTP contracts (`@wanderly/contracts`). */

export function toConversationSummary(conversation: Conversation): ConversationSummary {
  return {
    id: conversation.id,
    title: conversation.title,
    createdAt: conversation.createdAt.toISOString(),
    updatedAt: conversation.updatedAt.toISOString(),
  };
}

export function toAssistantMessage(message: {
  readonly id: string;
  readonly runId: string;
  readonly response: AgentResponse;
  readonly sources: readonly SourceSummary[];
  readonly toolCalls: readonly ToolCallSummary[];
  readonly createdAt: Date;
}): AssistantMessage {
  return {
    id: message.id,
    role: 'assistant',
    runId: message.runId,
    response: message.response,
    sources: [...message.sources],
    toolCalls: [...message.toolCalls],
    createdAt: message.createdAt.toISOString(),
  };
}

/**
 * Each completed turn shows as the user's message followed by the assistant's answer. A loaded
 * answer also carries its run stats and the session's rating (the live `response` event does not:
 * stats arrive in `run.finished`).
 */
export function toConversationMessages(turns: readonly ConversationTurn[]): ConversationMessage[] {
  return turns.flatMap((turn): ConversationMessage[] => [
    {
      id: turn.userMessageId,
      role: 'user',
      text: turn.userText,
      createdAt: turn.userCreatedAt.toISOString(),
    },
    {
      ...toAssistantMessage({
        id: turn.assistantMessageId,
        runId: turn.runId,
        response: turn.response,
        sources: turn.sources,
        toolCalls: turn.toolCalls,
        createdAt: turn.completedAt,
      }),
      run: { ...turn.run, usage: { ...turn.run.usage } },
      feedback: turn.feedbackRating === null ? null : { rating: turn.feedbackRating },
    },
  ]);
}

export function toConversationDetail(
  conversation: Conversation,
  turns: readonly ConversationTurn[],
): GetConversationResponse {
  return {
    ...toConversationSummary(conversation),
    brief: conversation.brief,
    messages: toConversationMessages(turns),
  };
}
