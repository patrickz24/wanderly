import { MAX_USER_MESSAGE_CHARS } from '@wanderly/contracts';
import { fireEvent, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { useState } from 'react';
import { describe, expect, it, vi } from 'vitest';
import { Composer } from './Composer';

interface HarnessProps {
  readonly initial?: string;
  readonly running?: boolean;
  readonly onSend?: (text: string) => void;
  readonly onStop?: () => void;
}

/** The composer is controlled; this keeps its value like the chat does. */
function Harness({
  initial = '',
  running = false,
  onSend = vi.fn(),
  onStop = vi.fn(),
}: HarnessProps) {
  const [value, setValue] = useState(initial);
  return (
    <Composer value={value} onChange={setValue} onSend={onSend} onStop={onStop} running={running} />
  );
}

const textbox = () => screen.getByRole('textbox', { name: 'Message' });

describe('Composer', () => {
  it('sends the trimmed text with Enter', async () => {
    const onSend = vi.fn();
    render(<Harness onSend={onSend} />);

    await userEvent.type(textbox(), '  A week in Sicily  {Enter}');

    expect(onSend).toHaveBeenCalledExactlyOnceWith('A week in Sicily');
  });

  it('adds a new line with Shift+Enter instead of sending', async () => {
    const onSend = vi.fn();
    render(<Harness onSend={onSend} />);

    await userEvent.type(textbox(), 'Line one{Shift>}{Enter}{/Shift}Line two');

    expect(textbox()).toHaveValue('Line one\nLine two');
    expect(onSend).not.toHaveBeenCalled();
  });

  it('does not send while an input method is composing', () => {
    const onSend = vi.fn();
    render(<Harness initial="こんにちは" onSend={onSend} />);

    fireEvent.keyDown(textbox(), { key: 'Enter', isComposing: true });

    expect(onSend).not.toHaveBeenCalled();
  });

  it('does not send an empty or blank message', async () => {
    const onSend = vi.fn();
    render(<Harness onSend={onSend} />);

    await userEvent.type(textbox(), '   {Enter}');

    expect(onSend).not.toHaveBeenCalled();
    expect(screen.getByRole('button', { name: 'Send' })).toBeDisabled();
  });

  it('sends with the button', async () => {
    const onSend = vi.fn();
    render(<Harness initial="Crete in June" onSend={onSend} />);

    await userEvent.click(screen.getByRole('button', { name: 'Send' }));

    expect(onSend).toHaveBeenCalledWith('Crete in June');
  });

  it('counts characters and caps the message at the API limit', () => {
    render(<Harness initial="Hello" />);

    expect(textbox()).toHaveAttribute('maxLength', String(MAX_USER_MESSAGE_CHARS));
    expect(textbox()).toHaveAccessibleDescription(/5 of 2,000 characters used/);
  });

  it('warns when the message gets close to the limit', () => {
    render(<Harness initial={'x'.repeat(1900)} />);

    const counter = screen.getByText('1,900 of 2,000 characters used').parentElement;
    expect(counter).toHaveClass('text-danger');
  });

  it('blocks sending during a run but keeps the text area usable, and offers Stop', async () => {
    const onSend = vi.fn();
    const onStop = vi.fn();
    render(<Harness initial="Next question" running onSend={onSend} onStop={onStop} />);

    expect(textbox()).toBeEnabled();
    expect(screen.queryByRole('button', { name: 'Send' })).not.toBeInTheDocument();

    await userEvent.type(textbox(), '{Enter}');
    expect(onSend).not.toHaveBeenCalled();

    await userEvent.click(screen.getByRole('button', { name: 'Stop' }));
    expect(onStop).toHaveBeenCalledOnce();
  });
});
