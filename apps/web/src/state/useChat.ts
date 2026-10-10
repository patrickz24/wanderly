import type { FeedbackRequest } from '@wanderly/contracts';
import { useCallback, useEffect, useReducer, useRef, type Dispatch } from 'react';
import { ApiError } from '../lib/api';
import type { ChatTransport } from '../lib/chatApi';
import { toChatError } from '../lib/chatErrors';
import {
  canSend,
  chatReducer,
  initChatState,
  type ChatAction,
  type ChatState,
} from './chatReducer';

/** What happened to a message handed to `send`. */
export type SendOutcome =
  /** The server accepted the message (`run.started`), whatever happened next. */
  | 'delivered'
  /** The server never accepted it (refused, offline, stopped early): give the text back. */
  | 'not-delivered';

export interface ChatController {
  readonly state: ChatState;
  send(text: string): Promise<SendOutcome>;
  /** Stops the run in flight (the "Stop" button). */
  stop(): void;
  startNewConversation(): void;
  openConversation(id: string): void;
  sendFeedback(runId: string, feedback: FeedbackRequest): Promise<void>;
  dismissError(): void;
}

let localIdCounter = 0;

/** Ids for optimistic messages and client runs; never sent to the server. */
function createLocalId(prefix: string): string {
  localIdCounter += 1;
  return `${prefix}-${Date.now().toString(36)}-${localIdCounter}`;
}

function isAbort(error: unknown, signal: AbortSignal): boolean {
  return signal.aborted && (!(error instanceof ApiError) || error.kind === 'aborted');
}

async function loadConversation(
  transport: ChatTransport,
  dispatch: Dispatch<ChatAction>,
  id: string,
  signal: AbortSignal,
): Promise<void> {
  try {
    const { conversation, runStats } = await transport.getConversation(id, signal);
    dispatch({ type: 'conversation/loaded', conversation, stats: runStats });
  } catch (error) {
    if (!isAbort(error, signal)) {
      dispatch({ type: 'conversation/load-failed', id, error: toChatError(error) });
    }
  }
}

export interface UseChatOptions {
  /** Conversation to open on mount (demo mode). */
  readonly initialConversationId?: string | null;
  /** Called when the server-side list of conversations may have changed. */
  readonly onConversationsChanged?: () => void;
}

/**
 * Drives one conversation: optimistic sends, the streamed run, resume and feedback. At most one
 * run is in flight: starting another action aborts it, and unmounting aborts everything.
 */
export function useChat(transport: ChatTransport, options: UseChatOptions = {}): ChatController {
  const { initialConversationId = null, onConversationsChanged } = options;
  const [state, dispatch] = useReducer(chatReducer, initialConversationId, initChatState);
  const runAbort = useRef<AbortController | null>(null);
  const loadAbort = useRef<AbortController | null>(null);
  const onChanged = useRef(onConversationsChanged);

  useEffect(() => {
    onChanged.current = onConversationsChanged;
  }, [onConversationsChanged]);

  useEffect(() => {
    if (initialConversationId === null) {
      return undefined;
    }
    const controller = new AbortController();
    loadAbort.current = controller;
    void loadConversation(transport, dispatch, initialConversationId, controller.signal);
    return () => {
      controller.abort();
    };
  }, [transport, initialConversationId]);

  useEffect(
    () => () => {
      runAbort.current?.abort();
      loadAbort.current?.abort();
    },
    [],
  );

  const abortAll = useCallback(() => {
    runAbort.current?.abort();
    loadAbort.current?.abort();
  }, []);

  const { conversationId } = state;
  const busy = !canSend(state);

  const send = useCallback(
    async (text: string): Promise<SendOutcome> => {
      const trimmed = text.trim();
      if (trimmed === '' || busy) {
        return 'not-delivered';
      }
      const controller = new AbortController();
      runAbort.current = controller;
      const clientRunId = createLocalId('run');
      let delivered = false;
      dispatch({
        type: 'run/submitted',
        clientRunId,
        localMessageId: createLocalId('message'),
        text: trimmed,
        createdAt: new Date().toISOString(),
      });

      try {
        let targetId = conversationId;
        if (targetId === null) {
          const created = await transport.createConversation(controller.signal);
          dispatch({ type: 'conversation/created', clientRunId, conversation: created });
          targetId = created.id;
        }
        await transport.sendMessage(targetId, trimmed, {
          signal: controller.signal,
          onEvent: (event) => {
            if (event.type === 'run.started') {
              delivered = true;
            }
            dispatch({ type: 'run/event', clientRunId, event });
          },
        });
      } catch (error) {
        if (isAbort(error, controller.signal)) {
          dispatch({ type: 'run/stopped', clientRunId });
        } else {
          dispatch({ type: 'run/failed', clientRunId, error: toChatError(error) });
        }
      } finally {
        if (runAbort.current === controller) {
          runAbort.current = null;
        }
        onChanged.current?.();
      }
      return delivered ? 'delivered' : 'not-delivered';
    },
    [transport, conversationId, busy],
  );

  const stop = useCallback(() => {
    runAbort.current?.abort();
  }, []);

  const startNewConversation = useCallback(() => {
    abortAll();
    dispatch({ type: 'conversation/new' });
  }, [abortAll]);

  const openConversation = useCallback(
    (id: string) => {
      abortAll();
      const controller = new AbortController();
      loadAbort.current = controller;
      dispatch({ type: 'conversation/loading', id });
      void loadConversation(transport, dispatch, id, controller.signal);
    },
    [transport, abortAll],
  );

  const feedbackInFlight = useRef(new Set<string>());

  const sendFeedback = useCallback(
    async (runId: string, feedback: FeedbackRequest): Promise<void> => {
      // The reducer also refuses a second rating; this guard stops a double click from
      // reaching the network before React has re-rendered the disabled button.
      if (feedbackInFlight.current.has(runId)) {
        return;
      }
      feedbackInFlight.current.add(runId);
      dispatch({ type: 'feedback/sending', runId, rating: feedback.rating });
      try {
        await transport.postFeedback(runId, feedback);
        dispatch({ type: 'feedback/sent', runId });
      } catch (error) {
        feedbackInFlight.current.delete(runId);
        dispatch({ type: 'feedback/failed', runId, error: toChatError(error) });
      }
    },
    [transport],
  );

  const dismissError = useCallback(() => {
    dispatch({ type: 'error/dismissed' });
  }, []);

  return { state, send, stop, startNewConversation, openConversation, sendFeedback, dismissError };
}
