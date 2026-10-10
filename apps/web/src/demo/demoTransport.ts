import type { AgentEvent, ConversationSummary, GetConversationResponse } from '@wanderly/contracts';
import { ApiError } from '../lib/api';
import type { ChatTransport, LoadedConversation } from '../lib/chatApi';
import type { AssistantMessage, RunStats } from '../lib/types';
import {
  DEMO_CONVERSATIONS,
  DEMO_REPLAY,
  DEMO_REPLAY_SOURCE_REFS,
  DEMO_RUN_STATS,
} from './fixtures';

export interface DemoTransportOptions {
  /** Scales the replay delays; 0 makes tests instant. */
  readonly speed?: number;
  readonly now?: () => Date;
}

/** RFC 4122 v4 UUID from `getRandomValues` (`randomUUID` needs a secure context). */
function uuid(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  bytes[6] = ((bytes[6] ?? 0) & 0x0f) | 0x40;
  bytes[8] = ((bytes[8] ?? 0) & 0x3f) | 0x80;
  const hex = Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

function wait(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    const abort = (): void => {
      clearTimeout(timer);
      reject(new ApiError('aborted', 'The request was cancelled.'));
    };
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', abort);
      resolve();
    }, ms);
    if (signal?.aborted === true) {
      abort();
      return;
    }
    signal?.addEventListener('abort', abort, { once: true });
  });
}

function notFound(): ApiError {
  return new ApiError('http', 'Conversation not found.', { status: 404, code: 'NOT_FOUND' });
}

const TITLE_MAX_CHARS = 60;

/**
 * A `ChatTransport` over the sample conversations, for demo mode. Nothing leaves the browser:
 * sending a message replays a recorded run (tool events with realistic pauses, then a fixed
 * answer that says it is a replay), and new conversations live in memory until reload.
 */
export function createDemoTransport(options: DemoTransportOptions = {}): ChatTransport {
  const { speed = 1, now = () => new Date() } = options;
  const conversations = new Map<string, GetConversationResponse>(
    DEMO_CONVERSATIONS.map((conversation) => [conversation.id, structuredClone(conversation)]),
  );
  const runStats = new Map<string, RunStats>(Object.entries(DEMO_RUN_STATS));
  const pause = (ms: number, signal?: AbortSignal): Promise<void> => wait(ms * speed, signal);

  const summaries = (): ConversationSummary[] =>
    [...conversations.values()].map(({ id, title, createdAt, updatedAt }) => ({
      id,
      title,
      createdAt,
      updatedAt,
    }));

  return {
    async listConversations(signal) {
      await pause(150, signal);
      return summaries();
    },

    async createConversation(signal) {
      await pause(100, signal);
      const timestamp = now().toISOString();
      const conversation: GetConversationResponse = {
        id: uuid(),
        title: null,
        createdAt: timestamp,
        updatedAt: timestamp,
        brief: {
          destinationId: null,
          month: null,
          startDate: null,
          durationDays: null,
          travelers: null,
          budgetLevel: null,
          interests: [],
          constraints: [],
        },
        messages: [],
      };
      conversations.set(conversation.id, conversation);
      return { id: conversation.id, title: null, createdAt: timestamp, updatedAt: timestamp };
    },

    async getConversation(id, signal): Promise<LoadedConversation> {
      await pause(200, signal);
      const conversation = conversations.get(id);
      if (conversation === undefined) {
        throw notFound();
      }
      const stats: Record<string, RunStats> = {};
      for (const message of conversation.messages) {
        const value = message.role === 'assistant' ? runStats.get(message.runId) : undefined;
        if (message.role === 'assistant' && value !== undefined) {
          stats[message.runId] = value;
        }
      }
      return { conversation: structuredClone(conversation), runStats: stats };
    },

    async sendMessage(conversationId, text, { signal, onEvent }) {
      const conversation = conversations.get(conversationId);
      if (conversation === undefined) {
        throw notFound();
      }
      const runId = uuid();
      const emit = (event: AgentEvent): void => onEvent(event);

      await pause(350, signal);
      const userMessage = {
        id: uuid(),
        role: 'user' as const,
        text,
        createdAt: now().toISOString(),
      };
      conversation.messages.push(userMessage);
      conversation.title ??=
        text.length <= TITLE_MAX_CHARS ? text : `${text.slice(0, TITLE_MAX_CHARS - 1)}…`;
      emit({ type: 'run.started', runId, conversationId, userMessageId: userMessage.id });

      for (const call of DEMO_REPLAY.toolCalls) {
        await pause(250, signal);
        emit({
          type: 'tool.started',
          runId,
          callId: call.callId,
          name: call.name,
          input: call.input,
        });
        await pause(call.durationMs + 400, signal);
        emit({ type: 'tool.finished', runId, call });
      }

      await pause(900, signal);
      const answer: AssistantMessage = {
        id: uuid(),
        role: 'assistant',
        runId,
        response: {
          type: 'answer',
          message: DEMO_REPLAY.message,
          sourceRefs: [...DEMO_REPLAY_SOURCE_REFS],
          brief: conversation.brief,
        },
        sources: DEMO_REPLAY.sources,
        toolCalls: DEMO_REPLAY.toolCalls,
        createdAt: now().toISOString(),
      };
      conversation.messages.push(answer);
      conversation.updatedAt = answer.createdAt;
      runStats.set(runId, DEMO_REPLAY.stats);
      emit({ type: 'response', runId, message: answer });

      await pause(150, signal);
      emit({ type: 'run.finished', runId, ...DEMO_REPLAY.stats });
    },

    async postFeedback(_runId, _feedback, signal) {
      await pause(300, signal);
    },
  };
}
