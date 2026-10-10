import type { ConversationSummary } from '@wanderly/contracts';
import { useCallback, useEffect, useRef, useState } from 'react';
import { ApiError } from '../lib/api';
import type { ChatTransport } from '../lib/chatApi';
import { toChatError, type ChatError } from '../lib/chatErrors';

export type ConversationListState =
  | { readonly status: 'loading' }
  | { readonly status: 'ready'; readonly conversations: readonly ConversationSummary[] }
  | { readonly status: 'failed'; readonly error: ChatError };

export interface ConversationList {
  readonly state: ConversationListState;
  /** Reloads the list; keeps showing the current one meanwhile. */
  refresh(): void;
}

/** Most recently updated first, whatever order the server used. */
function byMostRecent(conversations: readonly ConversationSummary[]): ConversationSummary[] {
  return [...conversations].sort((a, b) => Date.parse(b.updatedAt) - Date.parse(a.updatedAt));
}

/** The session's resumable conversations (anonymous cookie session on the API side). */
export function useConversationList(transport: ChatTransport): ConversationList {
  const [state, setState] = useState<ConversationListState>({ status: 'loading' });
  const [generation, setGeneration] = useState(0);
  const latest = useRef(0);

  useEffect(() => {
    const controller = new AbortController();
    const request = generation;
    latest.current = request;
    transport.listConversations(controller.signal).then(
      (conversations) => {
        if (latest.current === request) {
          setState({ status: 'ready', conversations: byMostRecent(conversations) });
        }
      },
      (error: unknown) => {
        const aborted = error instanceof ApiError && error.kind === 'aborted';
        if (latest.current === request && !aborted) {
          setState((previous) =>
            // A failed background refresh keeps the list the user is looking at.
            previous.status === 'ready' && request > 0
              ? previous
              : { status: 'failed', error: toChatError(error) },
          );
        }
      },
    );
    return () => {
      controller.abort();
    };
  }, [transport, generation]);

  const refresh = useCallback(() => {
    setState((previous) => (previous.status === 'failed' ? { status: 'loading' } : previous));
    setGeneration((value) => value + 1);
  }, []);

  return { state, refresh };
}
