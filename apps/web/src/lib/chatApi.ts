import {
  CreateConversationResponseSchema,
  GetConversationResponseSchema,
  ListConversationsResponseSchema,
  type AgentEvent,
  type ConversationSummary,
  type FeedbackRequest,
  type GetConversationResponse,
} from '@wanderly/contracts';
import { apiRequest } from './api';
import { streamAgentRun } from './agentStream';
import type { RunStats } from './types';

export interface SendMessageOptions {
  readonly signal: AbortSignal;
  readonly onEvent: (event: AgentEvent) => void;
}

/** A conversation as the chat needs it to resume. */
export interface LoadedConversation {
  readonly conversation: GetConversationResponse;
  /**
   * Footer statistics of past runs, by run id. The HTTP API does not return them for stored
   * conversations yet, so this is empty there; the demo transport fills it.
   */
  readonly runStats: Readonly<Record<string, RunStats>>;
}

/**
 * Everything the chat needs from the outside world. The HTTP implementation talks to the API;
 * the demo implementation replays fixtures, so the UI runs (and is tested) without a server.
 */
export interface ChatTransport {
  listConversations(signal?: AbortSignal): Promise<readonly ConversationSummary[]>;
  createConversation(signal?: AbortSignal): Promise<ConversationSummary>;
  getConversation(id: string, signal?: AbortSignal): Promise<LoadedConversation>;
  /** Resolves once the run has ended (terminal event); see `streamAgentRun`. */
  sendMessage(conversationId: string, text: string, options: SendMessageOptions): Promise<void>;
  postFeedback(runId: string, feedback: FeedbackRequest, signal?: AbortSignal): Promise<void>;
}

const ignoreBody = (): void => undefined;

const conversationPath = (id: string): string => `/api/conversations/${encodeURIComponent(id)}`;

export const httpTransport: ChatTransport = {
  async listConversations(signal) {
    const { conversations } = await apiRequest(
      '/api/conversations',
      (data) => ListConversationsResponseSchema.parse(data),
      { signal },
    );
    return conversations;
  },

  createConversation(signal) {
    return apiRequest(
      '/api/conversations',
      (data) => CreateConversationResponseSchema.parse(data),
      { method: 'POST', signal },
    );
  },

  async getConversation(id, signal) {
    const conversation = await apiRequest(
      conversationPath(id),
      (data) => GetConversationResponseSchema.parse(data),
      { signal },
    );
    return { conversation, runStats: {} };
  },

  sendMessage(conversationId, text, options) {
    return streamAgentRun(conversationId, text, options);
  },

  postFeedback(runId, feedback, signal) {
    return apiRequest(`/api/runs/${encodeURIComponent(runId)}/feedback`, ignoreBody, {
      method: 'POST',
      body: feedback,
      signal,
    });
  },
};
