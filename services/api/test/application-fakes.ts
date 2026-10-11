/**
 * In-memory fakes of the application ports, shared by use case, HTTP and integration tests. They
 * implement the same contracts as the Postgres adapters (which integration tests cover).
 */
import {
  EMPTY_TRIP_BRIEF,
  type AgentResponse,
  type SourceSummary,
  type ToolCallSummary,
} from '@wanderly/contracts';
import type {
  Conversation,
  ConversationRepository,
  ConversationTurn,
  NewMessage,
} from '../src/application/ports/conversations.js';
import type {
  Feedback,
  FeedbackRepository,
  RunRecord,
  RunRepository,
  SpendLedger,
} from '../src/application/ports/runs.js';
import type { IdGenerator } from '../src/application/ports/system.js';
import type { UnitOfWork } from '../src/application/ports/unit-of-work.js';
import { NotFoundError } from '../src/domain/errors.js';
import type { LlmMessage } from '../src/domain/ports/llm.js';
import type {
  Clock,
  LlmCallRecord,
  RunTrace,
  RunTraceEnd,
  RunTraceStart,
  ToolCallRecord,
  Tracer,
} from '../src/domain/ports/tracer.js';

export const SESSION_A = 'session-a';
export const SESSION_B = 'session-b';

/** Deterministic, valid UUID v4 values: `…-000000000001`, `…-000000000002`… */
export function sequentialIds(): IdGenerator & { readonly issued: string[] } {
  const issued: string[] = [];
  return {
    issued,
    newId() {
      const id = `00000000-0000-4000-8000-${String(issued.length + 1).padStart(12, '0')}`;
      issued.push(id);
      return id;
    },
  };
}

export function manualClock(start = '2026-10-10T09:00:00.000Z'): Clock & {
  set(iso: string): void;
  advance(ms: number): void;
} {
  let now = new Date(start);
  return {
    now: () => new Date(now),
    set(iso) {
      now = new Date(iso);
    },
    advance(ms) {
      now = new Date(now.getTime() + ms);
    },
  };
}

interface StoredMessage extends NewMessage {
  readonly conversationId: string;
  readonly seq: number;
}

/** One in-memory database behind every repository port, with transactional rollback. */
export class InMemoryStore {
  conversations = new Map<string, Conversation>();
  messages: StoredMessage[] = [];
  runs: RunRecord[] = [];
  feedback = new Map<string, Feedback>();
  /** Makes the next write of this kind fail (simulates a database error). */
  failNext: { appendMessages?: Error; saveRun?: Error } = {};

  readonly conversationRepository: ConversationRepository = {
    create: async ({ id, sessionId, brief, now }) => {
      const conversation: Conversation = {
        id,
        sessionId,
        title: null,
        brief,
        createdAt: now,
        updatedAt: now,
      };
      this.conversations.set(id, conversation);
      return conversation;
    },
    listForSession: async (sessionId, limit) =>
      [...this.conversations.values()]
        .filter((conversation) => conversation.sessionId === sessionId)
        .sort((a, b) => b.updatedAt.getTime() - a.updatedAt.getTime())
        .slice(0, limit),
    findForSession: async (id, sessionId) => {
      const conversation = this.conversations.get(id);
      return conversation?.sessionId === sessionId ? conversation : null;
    },
    listTurns: async (conversationId) => this.turnsOf(conversationId),
    countCompletedTurns: async (conversationId) =>
      this.runs.filter((run) => run.conversationId === conversationId && run.status === 'ok')
        .length,
    loadHistory: async (conversationId) =>
      this.messagesOf(conversationId).map((stored) => stored.message),
    appendMessages: async (conversationId, messages) => {
      const failure = this.failNext.appendMessages;
      if (failure !== undefined) {
        this.failNext.appendMessages = undefined;
        throw failure;
      }
      const start = this.messagesOf(conversationId).length;
      messages.forEach((message, index) =>
        this.messages.push({ ...message, conversationId, seq: start + index }),
      );
    },
    updateAfterTurn: async (conversationId, update) => {
      const conversation = this.conversations.get(conversationId);
      if (conversation === undefined) throw new Error(`no conversation ${conversationId}`);
      this.conversations.set(conversationId, {
        ...conversation,
        brief: update.brief,
        title: conversation.title ?? update.titleIfUnset,
        updatedAt: update.updatedAt,
      });
    },
    markActive: async (conversationId, at) => {
      const conversation = this.conversations.get(conversationId);
      if (conversation === undefined) throw new NotFoundError('conversation', conversationId);
      if (at > conversation.updatedAt) {
        this.conversations.set(conversationId, { ...conversation, updatedAt: at });
      }
    },
  };

  readonly runRepository: RunRepository = {
    save: async (run) => {
      const failure = this.failNext.saveRun;
      if (failure !== undefined) {
        this.failNext.saveRun = undefined;
        throw failure;
      }
      this.runs.push(run);
    },
    findForSession: async (runId, sessionId) => {
      const run = this.runs.find((candidate) => candidate.id === runId);
      if (run === undefined) return null;
      const owner = this.conversations.get(run.conversationId);
      return owner?.sessionId === sessionId ? { id: run.id, traceId: run.traceId } : null;
    },
  };

  readonly feedbackRepository: FeedbackRepository = {
    upsert: async (feedback) => {
      this.feedback.set(feedback.runId, feedback);
    },
  };

  readonly ledger: SpendLedger & { extraSpentUsd: number } = {
    extraSpentUsd: 0,
    spentUsd: async (from, to) =>
      this.ledger.extraSpentUsd +
      this.runs
        .filter((run) => run.createdAt >= from && run.createdAt < to)
        .reduce((sum, run) => sum + run.costUsd, 0),
  };

  readonly unitOfWork: UnitOfWork = {
    inTransaction: async (work) => {
      const snapshot = {
        conversations: new Map(this.conversations),
        messages: [...this.messages],
        runs: [...this.runs],
      };
      try {
        return await work({
          conversations: this.conversationRepository,
          runs: this.runRepository,
        });
      } catch (error) {
        Object.assign(this, snapshot);
        throw error;
      }
    },
  };

  messagesOf(conversationId: string): StoredMessage[] {
    return this.messages
      .filter((message) => message.conversationId === conversationId)
      .sort((a, b) => a.seq - b.seq);
  }

  private turnsOf(conversationId: string): ConversationTurn[] {
    return this.runs
      .filter((run) => run.conversationId === conversationId && run.status === 'ok')
      .flatMap((run): ConversationTurn[] => {
        const user = this.messages.find((message) => message.id === run.userMessageId);
        if (run.response === null || run.userMessageId === null || user === undefined) return [];
        return [
          {
            runId: run.id,
            userMessageId: run.userMessageId,
            userText: run.userText,
            userCreatedAt: user.createdAt,
            assistantMessageId: run.assistantMessageId ?? run.id,
            response: run.response,
            sources: run.sources,
            toolCalls: run.toolCalls,
            completedAt: run.createdAt,
            run: {
              steps: run.steps,
              usage: run.usage,
              costUsd: run.costUsd,
              latencyMs: run.latencyMs,
              traceId: run.traceId,
            },
            feedbackRating: this.feedback.get(run.id)?.rating ?? null,
          },
        ];
      });
  }
}

export interface RecordedTrace {
  readonly start: RunTraceStart;
  readonly llmCalls: LlmCallRecord[];
  readonly toolCalls: ToolCallRecord[];
  readonly scores: Array<{ name: string; value: number; comment: string | undefined }>;
  end: RunTraceEnd | null;
}

/** A tracer that records everything it is told. */
export function recordingTracer(traceId: string | null = 'trace-1'): Tracer & {
  readonly traces: RecordedTrace[];
  readonly traceScores: Array<{ traceId: string; name: string; value: number; comment?: string }>;
} {
  const traces: RecordedTrace[] = [];
  const traceScores: Array<{ traceId: string; name: string; value: number; comment?: string }> = [];
  return {
    traces,
    traceScores,
    startRun(start): RunTrace {
      const recorded: RecordedTrace = { start, llmCalls: [], toolCalls: [], scores: [], end: null };
      traces.push(recorded);
      return {
        traceId,
        llmCall: (record) => recorded.llmCalls.push(record),
        toolCall: (record) => recorded.toolCalls.push(record),
        score: (name, value, comment) => recorded.scores.push({ name, value, comment }),
        end: (result) => {
          recorded.end = result;
        },
      };
    },
    scoreTrace(id, name, value, comment) {
      traceScores.push(
        comment === undefined
          ? { traceId: id, name, value }
          : { traceId: id, name, value, comment },
      );
    },
    flush: () => Promise.resolve(),
  };
}

export const SOURCES: readonly SourceSummary[] = [
  {
    kind: 'chunk',
    id: 'chunk-1',
    title: 'Sicily > When to go',
    destinationId: 'sicily',
    snippet: 'Spring is mild.',
    url: 'https://en.wikivoyage.org/wiki/Sicily',
  },
];

export const TOOL_CALLS: readonly ToolCallSummary[] = [
  {
    callId: 'call-1',
    name: 'search_knowledge',
    input: { query: 'Sicily in May' },
    ok: true,
    durationMs: 12,
    summary: '1 chunk',
  },
  {
    callId: 'call-2',
    name: 'get_seasonal_weather',
    input: { destinationId: 'sicily', month: 5 },
    ok: false,
    durationMs: 5,
    summary: 'timed out',
  },
];

export const ANSWER: AgentResponse = {
  type: 'answer',
  message: 'May is a lovely time to visit Sicily.',
  sourceRefs: [{ kind: 'chunk', id: 'chunk-1' }],
  brief: { ...EMPTY_TRIP_BRIEF, destinationId: 'sicily', month: 5 },
};

export function userTurn(text: string): LlmMessage {
  return { role: 'user', content: [{ type: 'text', text }] };
}

/** The messages a successful run appends: user turn, tool call, tool result, terminal call. */
export function exchange(text: string): LlmMessage[] {
  return [
    userTurn(text),
    {
      role: 'assistant',
      content: [
        { type: 'opaque', provider: 'fake', data: { thinking: '…', signature: 'sig' } },
        { type: 'tool_call', id: 'call-1', name: 'search_knowledge', input: { query: text } },
      ],
    },
    {
      role: 'user',
      content: [{ type: 'tool_result', toolCallId: 'call-1', content: '[]', isError: false }],
    },
    {
      role: 'assistant',
      content: [{ type: 'tool_call', id: 'call-3', name: 'answer_question', input: {} }],
    },
  ];
}
