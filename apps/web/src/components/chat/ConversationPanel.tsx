import type { FeedbackRequest } from '@wanderly/contracts';
import { useEffect, useId, useRef, type Ref } from 'react';
import { canSend, latestAssistantMessage, type ChatState } from '../../state/chatReducer';
import { AssistantMessageView } from './AssistantMessageView';
import { Composer } from './Composer';
import { EmptyState } from './EmptyState';
import { ErrorAlert } from './ErrorAlert';
import { RunProgress } from './RunProgress';
import { UserMessageView } from './UserMessageView';

interface ConversationPanelProps {
  readonly state: ChatState;
  readonly draft: string;
  readonly onDraftChange: (value: string) => void;
  readonly onSend: (text: string) => void;
  readonly onStop: () => void;
  readonly onPickExample: (prompt: string) => void;
  readonly onFeedback: (runId: string, feedback: FeedbackRequest) => void;
  readonly onDismissError: () => void;
  readonly onStartNew: () => void;
  readonly illustrativeStats: boolean;
  readonly textareaRef: Ref<HTMLTextAreaElement>;
  /** Focused when a trip is opened, so keyboard and screen reader users land on it. */
  readonly headingRef: Ref<HTMLHeadingElement>;
}

function prefersReducedMotion(): boolean {
  return typeof window.matchMedia === 'function'
    ? window.matchMedia('(prefers-reduced-motion: reduce)').matches
    : false;
}

function panelTitle(state: ChatState): string {
  if (state.title !== null) {
    return state.title;
  }
  if (state.loading) {
    return 'Loading trip…';
  }
  return state.conversationId === null ? 'New trip' : 'Untitled trip';
}

/** The open conversation: messages, live progress, errors and the composer. */
export function ConversationPanel({
  state,
  draft,
  onDraftChange,
  onSend,
  onStop,
  onPickExample,
  onFeedback,
  onDismissError,
  onStartNew,
  illustrativeStats,
  textareaRef,
  headingRef,
}: ConversationPanelProps) {
  const headingId = useId();
  const lastMessageRef = useRef<HTMLLIElement>(null);
  const running = state.run !== null;
  const messageCount = state.messages.length;
  const latestAssistant = latestAssistantMessage(state);
  const quickReplyTarget = canSend(state) ? latestAssistant?.id : undefined;
  const empty = messageCount === 0 && !running && !state.loading;

  // Follow the conversation while a run adds messages (the sent message, then the answer),
  // but leave the scroll position alone when a stored conversation is opened.
  useEffect(() => {
    if (!running || messageCount === 0) {
      return;
    }
    const element = lastMessageRef.current;
    if (element !== null && typeof element.scrollIntoView === 'function') {
      element.scrollIntoView({
        block: 'start',
        behavior: prefersReducedMotion() ? 'auto' : 'smooth',
      });
    }
  }, [messageCount, running]);

  return (
    <section
      aria-labelledby={headingId}
      className="flex min-h-[70dvh] min-w-0 flex-col rounded-xl border border-line bg-surface shadow-sm"
    >
      <div className="border-b border-line px-4 py-3 sm:px-5">
        <h2
          id={headingId}
          ref={headingRef}
          tabIndex={-1}
          className="scroll-mt-4 truncate text-base font-semibold"
        >
          {panelTitle(state)}
        </h2>
      </div>

      <div className="flex-1 space-y-6 px-4 py-5 sm:px-5">
        {state.loading && (
          <p role="status" className="text-sm text-fg-muted">
            Loading the conversation…
          </p>
        )}
        {empty && state.error === null && <EmptyState onPickExample={onPickExample} />}

        {messageCount > 0 && (
          <ol aria-label="Messages" className="space-y-6">
            {state.messages.map((message, index) => (
              <li
                key={message.id}
                ref={index === messageCount - 1 ? lastMessageRef : undefined}
                className="scroll-mt-4"
              >
                {message.role === 'user' ? (
                  <UserMessageView message={message} />
                ) : (
                  <AssistantMessageView
                    message={message}
                    stats={state.stats[message.runId]}
                    illustrativeStats={illustrativeStats}
                    feedback={state.feedback[message.runId]}
                    onFeedback={onFeedback}
                    onQuickReply={message.id === quickReplyTarget ? onSend : undefined}
                  />
                )}
              </li>
            ))}
          </ol>
        )}

        {state.run !== null && <RunProgress run={state.run} />}

        {state.notice === 'stopped' && (
          <p role="status" className="text-sm text-fg-muted">
            Stopped. The answer to your last message was cancelled.
          </p>
        )}
        {state.error !== null && (
          <ErrorAlert error={state.error} onDismiss={onDismissError} onStartNew={onStartNew} />
        )}
      </div>

      <div className="sticky bottom-0 rounded-b-xl border-t border-line bg-surface/95 px-4 py-3 backdrop-blur sm:px-5">
        <Composer
          value={draft}
          onChange={onDraftChange}
          onSend={onSend}
          onStop={onStop}
          running={running}
          disabled={state.loading}
          textareaRef={textareaRef}
        />
      </div>
    </section>
  );
}
