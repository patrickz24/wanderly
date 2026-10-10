import { MAX_USER_MESSAGE_CHARS } from '@wanderly/contracts';
import { useId, type FormEvent, type KeyboardEvent, type Ref } from 'react';
import { formatInteger } from '../../lib/format';
import { SendIcon, StopIcon } from '../common/icons';

interface ComposerProps {
  readonly value: string;
  readonly onChange: (value: string) => void;
  readonly onSend: (text: string) => void;
  readonly onStop: () => void;
  /** A run is in flight: sending is disabled and "Stop" replaces "Send". */
  readonly running: boolean;
  /** Sending is impossible for another reason (e.g. a conversation is loading). */
  readonly disabled?: boolean;
  readonly textareaRef?: Ref<HTMLTextAreaElement>;
}

/** Above this share of the limit, the counter turns into a warning. */
const WARNING_RATIO = 0.9;

/**
 * Message box: Enter sends, Shift+Enter adds a line, 2,000 characters at most (the API limit).
 * The text area stays editable during a run so the next message can be prepared, and keeps
 * focus (a disabled control would drop it).
 */
export function Composer({
  value,
  onChange,
  onSend,
  onStop,
  running,
  disabled = false,
  textareaRef,
}: ComposerProps) {
  const inputId = useId();
  const hintId = useId();
  const counterId = useId();
  const length = value.length;
  const nearLimit = length >= MAX_USER_MESSAGE_CHARS * WARNING_RATIO;
  const canSend = !running && !disabled && value.trim() !== '' && length <= MAX_USER_MESSAGE_CHARS;

  const send = (): void => {
    if (canSend) {
      onSend(value.trim());
    }
  };

  const handleSubmit = (event: FormEvent<HTMLFormElement>): void => {
    event.preventDefault();
    send();
  };

  const handleKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>): void => {
    // Enter while an input method editor is composing confirms the composition, not the message.
    if (event.key !== 'Enter' || event.shiftKey || event.nativeEvent.isComposing) {
      return;
    }
    event.preventDefault();
    send();
  };

  return (
    <form onSubmit={handleSubmit} className="space-y-1.5">
      <label htmlFor={inputId} className="sr-only">
        Message
      </label>
      <div className="flex items-end gap-2">
        <textarea
          ref={textareaRef}
          id={inputId}
          value={value}
          onChange={(event) => onChange(event.target.value)}
          onKeyDown={handleKeyDown}
          maxLength={MAX_USER_MESSAGE_CHARS}
          rows={2}
          placeholder="Describe your trip: where, when, how long, budget, what you love…"
          aria-describedby={`${hintId} ${counterId}`}
          className="field-sizing-content block max-h-60 min-h-12 w-full flex-1 resize-none rounded-lg border border-line bg-surface px-3 py-2.5 placeholder:text-fg-muted"
        />
        {running ? (
          <button
            type="button"
            onClick={onStop}
            className="inline-flex shrink-0 items-center gap-1.5 rounded-lg border border-line bg-surface px-3.5 py-2.5 font-medium hover:bg-surface-muted"
          >
            <StopIcon />
            Stop
          </button>
        ) : (
          <button
            type="submit"
            disabled={!canSend}
            className="inline-flex shrink-0 items-center gap-1.5 rounded-lg bg-accent px-3.5 py-2.5 font-medium text-surface hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-50"
          >
            Send
            <SendIcon />
          </button>
        )}
      </div>
      <div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-1 text-xs text-fg-muted">
        <p id={hintId}>
          {running
            ? 'Wanderly is working on your last message. You can stop it or keep typing.'
            : 'Enter to send, Shift+Enter for a new line.'}
        </p>
        <p id={counterId} className={`tabular-nums ${nearLimit ? 'font-medium text-danger' : ''}`}>
          <span aria-hidden="true">
            {formatInteger(length)} / {formatInteger(MAX_USER_MESSAGE_CHARS)}
          </span>
          <span className="sr-only">
            {formatInteger(length)} of {formatInteger(MAX_USER_MESSAGE_CHARS)} characters used
          </span>
        </p>
      </div>
    </form>
  );
}
