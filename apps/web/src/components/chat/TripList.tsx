import { useId, useState } from 'react';
import { describeChatError } from '../../lib/chatErrors';
import { formatDateTime } from '../../lib/format';
import type { ConversationListState } from '../../state/useConversationList';
import { PlusIcon } from '../common/icons';

interface TripListProps {
  readonly state: ConversationListState;
  readonly activeId: string | null;
  readonly onSelect: (id: string) => void;
  readonly onNewTrip: () => void;
  readonly onRetry: () => void;
}

const UNTITLED = 'Untitled trip';

/**
 * "New trip" and the session's previous conversations. On small screens the list folds behind
 * a toggle so the chat stays first; from `lg` up it is a sidebar.
 */
export function TripList({ state, activeId, onSelect, onNewTrip, onRetry }: TripListProps) {
  const [expanded, setExpanded] = useState(false);
  const listId = useId();
  const headingId = useId();
  const count = state.status === 'ready' ? state.conversations.length : null;

  const select = (id: string): void => {
    setExpanded(false);
    onSelect(id);
  };

  return (
    <nav
      aria-labelledby={headingId}
      className="rounded-xl border border-line bg-surface p-4 shadow-sm lg:sticky lg:top-4"
    >
      <div className="flex items-center justify-between gap-2">
        <h2 id={headingId} className="text-base font-semibold">
          Your trips
        </h2>
        <button
          type="button"
          aria-expanded={expanded}
          aria-controls={listId}
          onClick={() => setExpanded((value) => !value)}
          className="rounded-md border border-line px-2.5 py-1 text-sm hover:bg-surface-muted lg:hidden"
        >
          {expanded ? 'Hide' : 'Show'}
          {count !== null && ` (${count})`}
        </button>
      </div>

      <button
        type="button"
        onClick={onNewTrip}
        className="mt-3 inline-flex w-full items-center justify-center gap-1.5 rounded-lg bg-accent px-3 py-2 text-sm font-medium text-surface hover:opacity-90"
      >
        <PlusIcon />
        New trip
      </button>

      <div id={listId} className={`mt-4 ${expanded ? 'block' : 'hidden'} lg:block`}>
        {state.status === 'loading' && (
          <p role="status" className="text-sm text-fg-muted">
            Loading your trips…
          </p>
        )}
        {state.status === 'failed' && (
          <div role="alert" className="space-y-2 text-sm">
            <p>{describeChatError(state.error).message}</p>
            <button
              type="button"
              onClick={onRetry}
              className="rounded-md border border-line px-2.5 py-1 font-medium hover:bg-surface-muted"
            >
              Retry
            </button>
          </div>
        )}
        {state.status === 'ready' && state.conversations.length === 0 && (
          <p className="text-sm text-fg-muted">No trips yet. Your conversations appear here.</p>
        )}
        {state.status === 'ready' && state.conversations.length > 0 && (
          <ul className="space-y-1">
            {state.conversations.map((conversation) => {
              const active = conversation.id === activeId;
              return (
                <li key={conversation.id}>
                  <button
                    type="button"
                    aria-current={active ? 'page' : undefined}
                    onClick={() => select(conversation.id)}
                    className={`w-full rounded-lg px-3 py-2 text-left hover:bg-surface-muted ${active ? 'bg-accent/10 ring-1 ring-accent/40' : ''}`}
                  >
                    <span className="block truncate text-sm font-medium">
                      {conversation.title ?? UNTITLED}
                    </span>
                    <span className="block text-xs text-fg-muted">
                      <time dateTime={conversation.updatedAt}>
                        {formatDateTime(conversation.updatedAt)}
                      </time>
                    </span>
                  </button>
                </li>
              );
            })}
          </ul>
        )}
        <p className="mt-4 text-xs text-fg-muted">
          Trips are tied to this browser and deleted after 30 days.
        </p>
      </div>
    </nav>
  );
}
