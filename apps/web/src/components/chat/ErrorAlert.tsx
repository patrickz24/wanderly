import { describeChatError, type ChatError } from '../../lib/chatErrors';
import { AlertIcon } from '../common/icons';

interface ErrorAlertProps {
  readonly error: ChatError;
  readonly onDismiss: () => void;
  /** Offered when the conversation itself is gone (NOT_FOUND). */
  readonly onStartNew?: () => void;
}

/** A friendly, actionable error. Raw server or browser messages are never shown. */
export function ErrorAlert({ error, onDismiss, onStartNew }: ErrorAlertProps) {
  const { title, message } = describeChatError(error);
  return (
    <div
      role="alert"
      className="flex gap-3 rounded-lg border border-danger/40 bg-danger/10 p-4 text-fg"
    >
      <AlertIcon className="mt-0.5 size-5 shrink-0 text-danger" />
      <div className="min-w-0 flex-1 space-y-2">
        <p className="font-semibold">{title}</p>
        <p className="text-sm">{message}</p>
        <div className="flex flex-wrap gap-2">
          {error.reason === 'NOT_FOUND' && onStartNew !== undefined && (
            <button
              type="button"
              onClick={onStartNew}
              className="rounded-md bg-accent px-3 py-1.5 text-sm font-medium text-surface hover:opacity-90"
            >
              Start a new trip
            </button>
          )}
          <button
            type="button"
            onClick={onDismiss}
            className="rounded-md border border-line bg-surface px-3 py-1.5 text-sm font-medium hover:bg-surface-muted"
          >
            Dismiss
          </button>
        </div>
      </div>
    </div>
  );
}
