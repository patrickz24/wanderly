import type {
  AgentEvent,
  AssistantMessage,
  ConversationSummary,
  GetConversationResponse,
  RunStats,
  ToolCallSummary,
  UserMessage,
} from '@wanderly/contracts';
import type { ChatError } from '../lib/chatErrors';

/**
 * State of the open conversation: its messages, the agent run in flight (with its live tool
 * timeline), the last error, and per-run statistics and feedback. Pure and synchronous, so
 * every transition is unit-tested without React.
 */

/** A user message; `pending` while the server has not confirmed it (optimistic display). */
export type ChatUserMessage = UserMessage & { readonly pending: boolean };
export type ChatMessage = ChatUserMessage | AssistantMessage;

export type ToolStepStatus = 'running' | 'ok' | 'error';

export interface ToolStep {
  readonly callId: string;
  readonly name: string;
  readonly input: unknown;
  readonly status: ToolStepStatus;
  readonly durationMs: number | null;
  readonly summary: string | null;
}

export interface ActiveRun {
  /** Client-side id: events of an abandoned run never touch the next one. */
  readonly clientRunId: string;
  /** Server run id, from `run.started`. */
  readonly runId: string | null;
  /** Local id until `run.started` confirms the message, then the server id. */
  readonly userMessageId: string;
  readonly tools: readonly ToolStep[];
  /** The answer has arrived; only `run.finished` (statistics) is still expected. */
  readonly responded: boolean;
}

export type FeedbackState =
  | { readonly status: 'sending'; readonly rating: 1 | -1 }
  | { readonly status: 'sent'; readonly rating: 1 | -1 }
  /** Rated before this visit (the stored conversation says so). */
  | { readonly status: 'rated'; readonly rating: 1 | -1 }
  | { readonly status: 'failed'; readonly rating: 1 | -1; readonly error: ChatError };

/** A neutral notice (not an error) about the last run. */
export type ChatNotice = 'stopped';

export interface ChatState {
  readonly conversationId: string | null;
  readonly title: string | null;
  /** The conversation is being fetched (resume). */
  readonly loading: boolean;
  readonly messages: readonly ChatMessage[];
  readonly run: ActiveRun | null;
  readonly error: ChatError | null;
  readonly notice: ChatNotice | null;
  /** Footer statistics by run id: from run.finished, or stored with a loaded message. */
  readonly stats: Readonly<Record<string, RunStats>>;
  /** Feedback by run id, kept across conversations: a run is rated once. */
  readonly feedback: Readonly<Record<string, FeedbackState>>;
}

export type ChatAction =
  | { readonly type: 'conversation/new' }
  | { readonly type: 'conversation/loading'; readonly id: string }
  | { readonly type: 'conversation/loaded'; readonly conversation: GetConversationResponse }
  | { readonly type: 'conversation/load-failed'; readonly id: string; readonly error: ChatError }
  | {
      readonly type: 'conversation/created';
      readonly clientRunId: string;
      readonly conversation: ConversationSummary;
    }
  | {
      readonly type: 'run/submitted';
      readonly clientRunId: string;
      readonly localMessageId: string;
      readonly text: string;
      readonly createdAt: string;
    }
  | { readonly type: 'run/event'; readonly clientRunId: string; readonly event: AgentEvent }
  | { readonly type: 'run/failed'; readonly clientRunId: string; readonly error: ChatError }
  | { readonly type: 'run/stopped'; readonly clientRunId: string }
  | { readonly type: 'feedback/sending'; readonly runId: string; readonly rating: 1 | -1 }
  | { readonly type: 'feedback/sent'; readonly runId: string }
  | { readonly type: 'feedback/failed'; readonly runId: string; readonly error: ChatError }
  | { readonly type: 'error/dismissed' };

export const INITIAL_CHAT_STATE: ChatState = {
  conversationId: null,
  title: null,
  loading: false,
  messages: [],
  run: null,
  error: null,
  notice: null,
  stats: {},
  feedback: {},
};

/** Initial state when the page opens on an existing conversation (e.g. demo mode). */
export function initChatState(conversationId: string | null): ChatState {
  return conversationId === null
    ? INITIAL_CHAT_STATE
    : { ...INITIAL_CHAT_STATE, conversationId, loading: true };
}

function toolStepFromCall(call: ToolCallSummary): ToolStep {
  return {
    callId: call.callId,
    name: call.name,
    input: call.input,
    status: call.ok ? 'ok' : 'error',
    durationMs: call.durationMs,
    summary: call.summary,
  };
}

function withTools(run: ActiveRun, tools: readonly ToolStep[]): ActiveRun {
  return { ...run, tools };
}

/**
 * Ends the active run. A user message the server never confirmed is withdrawn (the UI puts its
 * text back in the composer); a confirmed one stays, with the error shown below it. When the
 * answer already arrived, a late failure (lost `run.finished`) is not worth an error.
 */
function endRun(state: ChatState, error: ChatError | null, notice: ChatNotice | null): ChatState {
  const { run } = state;
  if (run === null) {
    return state;
  }
  const confirmed = run.runId !== null;
  return {
    ...state,
    run: null,
    messages: confirmed
      ? state.messages
      : state.messages.filter((message) => message.id !== run.userMessageId),
    error: run.responded ? null : error,
    notice: run.responded || !confirmed ? null : notice,
  };
}

function applyEvent(state: ChatState, run: ActiveRun, event: AgentEvent): ChatState {
  switch (event.type) {
    case 'run.started': {
      if (run.runId !== null) {
        return state;
      }
      return {
        ...state,
        conversationId: state.conversationId ?? event.conversationId,
        run: { ...run, runId: event.runId, userMessageId: event.userMessageId },
        messages: state.messages.map((message) =>
          message.id === run.userMessageId && message.role === 'user'
            ? { ...message, id: event.userMessageId, pending: false }
            : message,
        ),
      };
    }
    case 'tool.started': {
      if (run.tools.some((step) => step.callId === event.callId)) {
        return state;
      }
      const step: ToolStep = {
        callId: event.callId,
        name: event.name,
        input: event.input,
        status: 'running',
        durationMs: null,
        summary: null,
      };
      return { ...state, run: withTools(run, [...run.tools, step]) };
    }
    case 'tool.finished': {
      const finished = toolStepFromCall(event.call);
      const known = run.tools.some((step) => step.callId === finished.callId);
      const tools = known
        ? run.tools.map((step) => (step.callId === finished.callId ? finished : step))
        : [...run.tools, finished];
      return { ...state, run: withTools(run, tools) };
    }
    case 'response': {
      const alreadyThere = state.messages.some((message) => message.id === event.message.id);
      return {
        ...state,
        messages: alreadyThere ? state.messages : [...state.messages, event.message],
        run: { ...run, responded: true },
      };
    }
    case 'run.finished': {
      const { type: _type, runId, ...stats } = event;
      return { ...endRun(state, null, null), stats: { ...state.stats, [runId]: stats } };
    }
    case 'error':
      return endRun(state, { reason: event.error.code, retryAfterMs: null }, null);
  }
}

function assistantMessages(conversation: GetConversationResponse): AssistantMessage[] {
  return conversation.messages.filter((message) => message.role === 'assistant');
}

/** Run statistics the API stored with each answer. */
function storedStats(conversation: GetConversationResponse): Record<string, RunStats> {
  const stats: Record<string, RunStats> = {};
  for (const message of assistantMessages(conversation)) {
    if (message.run !== undefined) {
      stats[message.runId] = message.run;
    }
  }
  return stats;
}

/** Ratings given before this visit; a rating made during the visit takes precedence. */
function storedFeedback(conversation: GetConversationResponse): Record<string, FeedbackState> {
  const feedback: Record<string, FeedbackState> = {};
  for (const message of assistantMessages(conversation)) {
    if (message.feedback !== undefined && message.feedback !== null) {
      feedback[message.runId] = { status: 'rated', rating: message.feedback.rating };
    }
  }
  return feedback;
}

/** Run actions only apply to the run they were issued for. */
function activeRun(state: ChatState, clientRunId: string): ActiveRun | null {
  return state.run?.clientRunId === clientRunId ? state.run : null;
}

export function chatReducer(state: ChatState, action: ChatAction): ChatState {
  switch (action.type) {
    case 'conversation/new':
      return { ...INITIAL_CHAT_STATE, stats: state.stats, feedback: state.feedback };

    case 'conversation/loading':
      return {
        ...INITIAL_CHAT_STATE,
        conversationId: action.id,
        loading: true,
        stats: state.stats,
        feedback: state.feedback,
      };

    case 'conversation/loaded': {
      const { conversation } = action;
      if (conversation.id !== state.conversationId || !state.loading) {
        return state; // A newer selection superseded this load.
      }
      return {
        ...state,
        loading: false,
        title: conversation.title,
        messages: conversation.messages.map((message) =>
          message.role === 'user' ? { ...message, pending: false } : message,
        ),
        stats: { ...state.stats, ...storedStats(conversation) },
        feedback: { ...storedFeedback(conversation), ...state.feedback },
      };
    }

    case 'conversation/load-failed':
      if (action.id !== state.conversationId || !state.loading) {
        return state;
      }
      return { ...state, loading: false, error: action.error };

    case 'conversation/created':
      if (activeRun(state, action.clientRunId) === null || state.conversationId !== null) {
        return state;
      }
      return { ...state, conversationId: action.conversation.id, title: action.conversation.title };

    case 'run/submitted': {
      if (state.run !== null || state.loading) {
        return state;
      }
      const message: ChatUserMessage = {
        id: action.localMessageId,
        role: 'user',
        text: action.text,
        createdAt: action.createdAt,
        pending: true,
      };
      return {
        ...state,
        messages: [...state.messages, message],
        run: {
          clientRunId: action.clientRunId,
          runId: null,
          userMessageId: action.localMessageId,
          tools: [],
          responded: false,
        },
        error: null,
        notice: null,
      };
    }

    case 'run/event': {
      const run = activeRun(state, action.clientRunId);
      return run === null ? state : applyEvent(state, run, action.event);
    }

    case 'run/failed':
      return activeRun(state, action.clientRunId) === null
        ? state
        : endRun(state, action.error, null);

    case 'run/stopped':
      return activeRun(state, action.clientRunId) === null ? state : endRun(state, null, 'stopped');

    case 'feedback/sending': {
      const current = state.feedback[action.runId];
      if (current !== undefined && current.status !== 'failed') {
        return state; // Already sending or sent: a run is rated once.
      }
      return {
        ...state,
        feedback: {
          ...state.feedback,
          [action.runId]: { status: 'sending', rating: action.rating },
        },
      };
    }

    case 'feedback/sent': {
      const current = state.feedback[action.runId];
      if (current?.status !== 'sending') {
        return state;
      }
      return {
        ...state,
        feedback: { ...state.feedback, [action.runId]: { status: 'sent', rating: current.rating } },
      };
    }

    case 'feedback/failed': {
      const current = state.feedback[action.runId];
      if (current?.status !== 'sending') {
        return state;
      }
      return {
        ...state,
        feedback: {
          ...state.feedback,
          [action.runId]: { status: 'failed', rating: current.rating, error: action.error },
        },
      };
    }

    case 'error/dismissed':
      return { ...state, error: null, notice: null };
  }
}

/** Whether a new message can be sent now. */
export function canSend(state: ChatState): boolean {
  return state.run === null && !state.loading;
}

/** The last message of the conversation, when it is from the assistant. */
export function latestAssistantMessage(state: ChatState): AssistantMessage | null {
  const last = state.messages.at(-1);
  return last?.role === 'assistant' ? last : null;
}
