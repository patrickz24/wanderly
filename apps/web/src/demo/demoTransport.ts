import type {
  AgentEvent,
  AssistantMessage,
  ConversationSummary,
  GetConversationResponse,
  RunStats,
} from '@wanderly/contracts';
import { ApiError } from '../lib/api';
import type { ChatTransport } from '../lib/chatApi';
import { DEMO_CONVERSATIONS, DEMO_REPLAY, DEMO_REPLAY_SOURCE_REFS } from './fixtures';

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
 * The run.finished event must carry figures, but nothing is measured in demo mode: zeros,
 * which the UI never shows (demo mode hides every measured figure).
 */
const UNMEASURED: RunStats = {
  steps: 0,
  usage: { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 },
  costUsd: 0,
  latencyMs: 0,
  traceId: null,
};

/**
 * A `ChatTransport` over the sample conversations, for demo mode. Nothing leaves the browser:
 * sending a message replays a recorded run (tool events with pauses, then a fixed answer that
 * says it is a replay); new conversations and ratings live in memory until reload.
 */
export function createDemoTransport(options: DemoTransportOptions = {}): ChatTransport {
  const { speed = 1, now = () => new Date() } = options;
  const conversations = new Map<string, GetConversationResponse>(
    DEMO_CONVERSATIONS.map((conversation) => [conversation.id, structuredClone(conversation)]),
  );
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

    async getConversation(id, signal) {
      await pause(200, signal);
      const conversation = conversations.get(id);
      if (conversation === undefined) {
        throw notFound();
      }
      return structuredClone(conversation);
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
        await pause(600, signal);
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
      emit({ type: 'response', runId, message: answer });

      await pause(150, signal);
      emit({ type: 'run.finished', runId, ...UNMEASURED });
    },

    async postFeedback(runId, feedback, signal) {
      await pause(300, signal);
      for (const conversation of conversations.values()) {
        for (const message of conversation.messages) {
          if (message.role === 'assistant' && message.runId === runId) {
            message.feedback = { rating: feedback.rating };
          }
        }
      }
    },
  };
}
