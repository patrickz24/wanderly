import type { AgentEvent } from '@wanderly/contracts';
import { describe, expect, it } from 'vitest';
import {
  assistantMessage,
  conversationDetail,
  conversationSummary,
  failedCall,
  ids,
  NOW,
  runFinished,
  runStats,
  weatherCall,
} from '../test/factories';
import {
  canSend,
  chatReducer,
  INITIAL_CHAT_STATE,
  initChatState,
  latestAssistantMessage,
  type ChatAction,
  type ChatState,
} from './chatReducer';

const RUN = 'run-1';
const LOCAL = 'message-1';

function reduce(state: ChatState, ...actions: ChatAction[]): ChatState {
  return actions.reduce(chatReducer, state);
}

const submitted: ChatAction = {
  type: 'run/submitted',
  clientRunId: RUN,
  localMessageId: LOCAL,
  text: 'A week in Sicily',
  createdAt: NOW,
};

function event(value: AgentEvent, clientRunId = RUN): ChatAction {
  return { type: 'run/event', clientRunId, event: value };
}

const started = event({
  type: 'run.started',
  runId: ids.run,
  conversationId: ids.conversation,
  userMessageId: ids.userMessage,
});

const toolStarted = event({
  type: 'tool.started',
  runId: ids.run,
  callId: weatherCall.callId,
  name: weatherCall.name,
  input: weatherCall.input,
});

describe('chatReducer: sending', () => {
  it('shows the user message at once, as pending, and starts a run', () => {
    const state = reduce(INITIAL_CHAT_STATE, submitted);

    expect(state.messages).toEqual([
      { id: LOCAL, role: 'user', text: 'A week in Sicily', createdAt: NOW, pending: true },
    ]);
    expect(state.run).toMatchObject({ clientRunId: RUN, runId: null, tools: [] });
    expect(canSend(state)).toBe(false);
  });

  it('refuses a second message while a run is in flight', () => {
    const state = reduce(INITIAL_CHAT_STATE, submitted);
    expect(reduce(state, { ...submitted, clientRunId: 'run-2', localMessageId: 'm2' })).toBe(state);
  });

  it('confirms the user message with the server id on run.started', () => {
    const state = reduce(INITIAL_CHAT_STATE, submitted, started);

    expect(state.messages[0]).toMatchObject({ id: ids.userMessage, pending: false });
    expect(state.run).toMatchObject({ runId: ids.run, userMessageId: ids.userMessage });
    expect(state.conversationId).toBe(ids.conversation);
  });

  it('builds the tool timeline from tool events', () => {
    const state = reduce(
      INITIAL_CHAT_STATE,
      submitted,
      started,
      toolStarted,
      toolStarted, // duplicates are ignored
      event({ type: 'tool.finished', runId: ids.run, call: weatherCall }),
      event({ type: 'tool.finished', runId: ids.run, call: failedCall }), // no start seen
    );

    expect(state.run?.tools).toEqual([
      {
        callId: weatherCall.callId,
        name: weatherCall.name,
        input: weatherCall.input,
        status: 'ok',
        durationMs: 38,
        summary: weatherCall.summary,
      },
      {
        callId: failedCall.callId,
        name: failedCall.name,
        input: failedCall.input,
        status: 'error',
        durationMs: 5000,
        summary: 'Timed out after 5 s',
      },
    ]);
  });

  it('keeps a started tool as running until it finishes', () => {
    const state = reduce(INITIAL_CHAT_STATE, submitted, started, toolStarted);
    expect(state.run?.tools[0]).toMatchObject({ status: 'running', durationMs: null });
  });

  it('appends the answer once, then closes the run with its statistics', () => {
    const answer = assistantMessage();
    const withAnswer = reduce(
      INITIAL_CHAT_STATE,
      submitted,
      started,
      event({ type: 'response', runId: ids.run, message: answer }),
      event({ type: 'response', runId: ids.run, message: answer }),
    );
    expect(withAnswer.messages).toHaveLength(2);
    expect(withAnswer.run?.responded).toBe(true);

    const finished = reduce(withAnswer, event(runFinished()));
    expect(finished.run).toBeNull();
    expect(finished.stats[ids.run]).toEqual({
      steps: 4,
      usage: { inputTokens: 12000, outputTokens: 1500, cacheReadTokens: 8000, cacheWriteTokens: 0 },
      costUsd: 0.0215,
      latencyMs: 15400,
      traceId: null,
    });
    expect(latestAssistantMessage(finished)).toBe(answer);
    expect(canSend(finished)).toBe(true);
  });

  it('ignores events of a run that is no longer the active one', () => {
    const state = reduce(INITIAL_CHAT_STATE, submitted);
    expect(reduce(state, event(runFinished(), 'old-run'))).toBe(state);
    expect(
      reduce(state, {
        type: 'run/failed',
        clientRunId: 'old-run',
        error: { reason: 'NETWORK', retryAfterMs: null },
      }),
    ).toBe(state);
  });
});

describe('chatReducer: failures', () => {
  const rateLimited = { reason: 'RATE_LIMITED' as const, retryAfterMs: 42_000 };

  it('withdraws an unconfirmed message when the request is refused', () => {
    const state = reduce(INITIAL_CHAT_STATE, submitted, {
      type: 'run/failed',
      clientRunId: RUN,
      error: rateLimited,
    });

    expect(state.messages).toEqual([]);
    expect(state.run).toBeNull();
    expect(state.error).toEqual(rateLimited);
  });

  it('keeps a confirmed message and shows the error event below it', () => {
    const state = reduce(
      INITIAL_CHAT_STATE,
      submitted,
      started,
      event({
        type: 'error',
        runId: ids.run,
        error: { code: 'LLM_TIMEOUT', message: 'Took too long.' },
      }),
    );

    expect(state.messages).toHaveLength(1);
    expect(state.messages[0]).toMatchObject({ id: ids.userMessage, pending: false });
    expect(state.error).toEqual({ reason: 'LLM_TIMEOUT', retryAfterMs: null });
    expect(state.run).toBeNull();
  });

  it('withdraws the message on an error event before run.started', () => {
    const state = reduce(
      INITIAL_CHAT_STATE,
      submitted,
      event({ type: 'error', runId: null, error: { code: 'BUDGET_EXCEEDED', message: 'Spent.' } }),
    );
    expect(state.messages).toEqual([]);
    expect(state.error?.reason).toBe('BUDGET_EXCEEDED');
  });

  it('does not report an error when only run.finished was lost after the answer', () => {
    const state = reduce(
      INITIAL_CHAT_STATE,
      submitted,
      started,
      event({ type: 'response', runId: ids.run, message: assistantMessage() }),
      { type: 'run/failed', clientRunId: RUN, error: { reason: 'NETWORK', retryAfterMs: null } },
    );

    expect(state.error).toBeNull();
    expect(state.run).toBeNull();
    expect(state.messages).toHaveLength(2);
  });

  it('notes a stop after the message was accepted', () => {
    const state = reduce(INITIAL_CHAT_STATE, submitted, started, {
      type: 'run/stopped',
      clientRunId: RUN,
    });
    expect(state.notice).toBe('stopped');
    expect(state.messages).toHaveLength(1);
  });

  it('withdraws the message silently when stopped before it was accepted', () => {
    const state = reduce(INITIAL_CHAT_STATE, submitted, { type: 'run/stopped', clientRunId: RUN });
    expect(state.notice).toBeNull();
    expect(state.error).toBeNull();
    expect(state.messages).toEqual([]);
  });

  it('clears the error and notice on dismiss and on the next message', () => {
    const failed = reduce(INITIAL_CHAT_STATE, submitted, {
      type: 'run/failed',
      clientRunId: RUN,
      error: rateLimited,
    });
    expect(reduce(failed, { type: 'error/dismissed' }).error).toBeNull();
    expect(reduce(failed, { ...submitted, clientRunId: 'run-2' }).error).toBeNull();
  });
});

describe('chatReducer: conversations', () => {
  it('opens a stored conversation', () => {
    const loading = reduce(INITIAL_CHAT_STATE, {
      type: 'conversation/loading',
      id: ids.conversation,
    });
    expect(loading).toMatchObject({
      conversationId: ids.conversation,
      loading: true,
      messages: [],
    });
    expect(canSend(loading)).toBe(false);

    const loaded = reduce(loading, {
      type: 'conversation/loaded',
      conversation: conversationDetail(),
    });
    expect(loaded.loading).toBe(false);
    expect(loaded.title).toBe('Quiet hiking in Sicily');
    expect(loaded.messages.map((m) => m.role)).toEqual(['user', 'assistant']);
    expect(loaded.messages[0]).toMatchObject({ pending: false });
    expect(loaded.stats[ids.run]).toBeUndefined();
    expect(loaded.feedback[ids.run]).toBeUndefined();
  });

  it('takes run statistics and earlier ratings from the stored messages', () => {
    const conversation = conversationDetail({
      messages: [assistantMessage(undefined, { run: runStats(), feedback: { rating: -1 } })],
    });
    const loaded = reduce(
      INITIAL_CHAT_STATE,
      { type: 'conversation/loading', id: ids.conversation },
      { type: 'conversation/loaded', conversation },
    );

    expect(loaded.stats[ids.run]).toEqual(runStats());
    expect(loaded.feedback[ids.run]).toEqual({ status: 'rated', rating: -1 });
    // Already rated: a new rating is refused.
    expect(reduce(loaded, { type: 'feedback/sending', runId: ids.run, rating: 1 })).toBe(loaded);
  });

  it('keeps a rating given during this visit over the stored one', () => {
    const conversation = conversationDetail({
      messages: [assistantMessage(undefined, { feedback: { rating: -1 } })],
    });
    const loaded = reduce(
      INITIAL_CHAT_STATE,
      { type: 'feedback/sending', runId: ids.run, rating: 1 },
      { type: 'feedback/sent', runId: ids.run },
      { type: 'conversation/loading', id: ids.conversation },
      { type: 'conversation/loaded', conversation },
    );
    expect(loaded.feedback[ids.run]).toEqual({ status: 'sent', rating: 1 });
  });

  it('ignores a load that a newer selection superseded', () => {
    const state = reduce(
      INITIAL_CHAT_STATE,
      { type: 'conversation/loading', id: ids.conversation },
      { type: 'conversation/loading', id: ids.otherConversation },
    );
    expect(reduce(state, { type: 'conversation/loaded', conversation: conversationDetail() })).toBe(
      state,
    );
    expect(
      reduce(state, {
        type: 'conversation/load-failed',
        id: ids.conversation,
        error: { reason: 'NOT_FOUND', retryAfterMs: null },
      }),
    ).toBe(state);
  });

  it('reports a failed load', () => {
    const state = reduce(
      INITIAL_CHAT_STATE,
      { type: 'conversation/loading', id: ids.conversation },
      {
        type: 'conversation/load-failed',
        id: ids.conversation,
        error: { reason: 'NOT_FOUND', retryAfterMs: null },
      },
    );
    expect(state).toMatchObject({ loading: false, error: { reason: 'NOT_FOUND' } });
  });

  it('adopts the conversation created for the first message', () => {
    const state = reduce(INITIAL_CHAT_STATE, submitted, {
      type: 'conversation/created',
      clientRunId: RUN,
      conversation: conversationSummary({ title: null }),
    });
    expect(state.conversationId).toBe(ids.conversation);
  });

  it('starts a new trip but remembers feedback already given', () => {
    const rated = reduce(
      INITIAL_CHAT_STATE,
      { type: 'feedback/sending', runId: ids.run, rating: 1 },
      { type: 'feedback/sent', runId: ids.run },
    );
    const fresh = reduce(rated, { type: 'conversation/new' });
    expect(fresh.messages).toEqual([]);
    expect(fresh.conversationId).toBeNull();
    expect(fresh.feedback[ids.run]).toEqual({ status: 'sent', rating: 1 });
  });

  it('can start on a conversation to load', () => {
    expect(initChatState(ids.conversation)).toMatchObject({
      conversationId: ids.conversation,
      loading: true,
    });
    expect(initChatState(null)).toBe(INITIAL_CHAT_STATE);
  });
});

describe('chatReducer: feedback', () => {
  it('rates a run once', () => {
    const sending = reduce(INITIAL_CHAT_STATE, {
      type: 'feedback/sending',
      runId: ids.run,
      rating: -1,
    });
    expect(sending.feedback[ids.run]).toEqual({ status: 'sending', rating: -1 });
    expect(reduce(sending, { type: 'feedback/sending', runId: ids.run, rating: 1 })).toBe(sending);

    const sent = reduce(sending, { type: 'feedback/sent', runId: ids.run });
    expect(reduce(sent, { type: 'feedback/sending', runId: ids.run, rating: 1 })).toBe(sent);
  });

  it('allows a retry after a failure', () => {
    const failed = reduce(
      INITIAL_CHAT_STATE,
      { type: 'feedback/sending', runId: ids.run, rating: 1 },
      { type: 'feedback/failed', runId: ids.run, error: { reason: 'NETWORK', retryAfterMs: null } },
    );
    expect(failed.feedback[ids.run]).toMatchObject({ status: 'failed', rating: 1 });
    expect(
      reduce(failed, { type: 'feedback/sending', runId: ids.run, rating: 1 }).feedback[ids.run],
    ).toEqual({ status: 'sending', rating: 1 });
  });
});
