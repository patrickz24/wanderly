import type { FeedbackRequest } from '@wanderly/contracts';
import { useId, useState, type FormEvent } from 'react';
import { describeChatError } from '../../lib/chatErrors';
import type { FeedbackState } from '../../state/chatReducer';

export const MAX_FEEDBACK_COMMENT_CHARS = 500;

interface FeedbackControlsProps {
  readonly runId: string;
  readonly state: FeedbackState | undefined;
  readonly onSubmit: (runId: string, feedback: FeedbackRequest) => void;
}

type Rating = FeedbackRequest['rating'];

const RATINGS: readonly { rating: Rating; emoji: string; label: string }[] = [
  { rating: 1, emoji: '👍', label: 'Helpful' },
  { rating: -1, emoji: '👎', label: 'Not helpful' },
];

/**
 * 👍/👎 with an optional comment, sent once per run: choosing a rating opens the comment
 * field, and "Send" posts both together (the API stores one rating per run).
 */
export function FeedbackControls({ runId, state, onSubmit }: FeedbackControlsProps) {
  const [selected, setSelected] = useState<Rating | null>(null);
  const [comment, setComment] = useState('');
  const commentId = useId();
  const groupLabelId = useId();

  if (state?.status === 'sent') {
    return (
      <p role="status" className="text-sm text-fg-muted">
        Thanks for your feedback {state.rating === 1 ? '👍' : '👎'}
      </p>
    );
  }

  const sending = state?.status === 'sending';
  const rating = selected ?? state?.rating ?? null;

  const submit = (event: FormEvent<HTMLFormElement>): void => {
    event.preventDefault();
    if (rating === null || sending) {
      return;
    }
    const trimmed = comment.trim();
    onSubmit(runId, { rating, comment: trimmed === '' ? null : trimmed });
  };

  return (
    <form onSubmit={submit} className="space-y-2">
      <div className="flex flex-wrap items-center gap-2">
        <span id={groupLabelId} className="text-sm text-fg-muted">
          Was this helpful?
        </span>
        <div role="group" aria-labelledby={groupLabelId} className="flex gap-1.5">
          {RATINGS.map((option) => (
            <button
              key={option.rating}
              type="button"
              aria-label={option.label}
              aria-pressed={rating === option.rating}
              disabled={sending}
              onClick={() => setSelected(option.rating)}
              className="rounded-md border border-line bg-surface px-2.5 py-1 text-base hover:bg-surface-muted disabled:opacity-60 aria-pressed:border-accent aria-pressed:bg-accent/10"
            >
              <span aria-hidden="true">{option.emoji}</span>
            </button>
          ))}
        </div>
      </div>

      {rating !== null && (
        <div className="space-y-2">
          <label htmlFor={commentId} className="block text-sm text-fg-muted">
            Comment (optional)
          </label>
          <textarea
            id={commentId}
            value={comment}
            onChange={(event) => setComment(event.target.value)}
            maxLength={MAX_FEEDBACK_COMMENT_CHARS}
            rows={2}
            disabled={sending}
            placeholder="What worked, what didn't?"
            className="block w-full max-w-xl resize-y rounded-md border border-line bg-surface px-3 py-2 text-sm placeholder:text-fg-muted"
          />
          <div className="flex flex-wrap items-center gap-3">
            <button
              type="submit"
              disabled={sending}
              className="rounded-md bg-accent px-3 py-1.5 text-sm font-medium text-surface hover:opacity-90 disabled:opacity-60"
            >
              {sending ? 'Sending…' : 'Send feedback'}
            </button>
            {state?.status === 'failed' && (
              <p role="alert" className="text-sm text-danger">
                {describeChatError(state.error).message}
              </p>
            )}
          </div>
        </div>
      )}
    </form>
  );
}
