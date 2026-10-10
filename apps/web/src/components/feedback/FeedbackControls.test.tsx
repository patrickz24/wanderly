import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import type { FeedbackState } from '../../state/chatReducer';
import { FeedbackControls } from './FeedbackControls';

function renderControls(state?: FeedbackState) {
  const onSubmit = vi.fn();
  const view = render(<FeedbackControls runId="run-1" state={state} onSubmit={onSubmit} />);
  return { onSubmit, ...view };
}

describe('FeedbackControls', () => {
  it('asks for an optional comment after a rating, then sends both', async () => {
    const { onSubmit } = renderControls();
    expect(screen.queryByLabelText('Comment (optional)')).not.toBeInTheDocument();

    await userEvent.click(screen.getByRole('button', { name: 'Not helpful' }));
    expect(screen.getByRole('button', { name: 'Not helpful' })).toHaveAttribute(
      'aria-pressed',
      'true',
    );
    await userEvent.type(screen.getByLabelText('Comment (optional)'), '  Too many sites  ');
    await userEvent.click(screen.getByRole('button', { name: 'Send feedback' }));

    expect(onSubmit).toHaveBeenCalledExactlyOnceWith('run-1', {
      rating: -1,
      comment: 'Too many sites',
    });
  });

  it('sends a null comment when none is written', async () => {
    const { onSubmit } = renderControls();

    await userEvent.click(screen.getByRole('button', { name: 'Helpful' }));
    await userEvent.click(screen.getByRole('button', { name: 'Send feedback' }));

    expect(onSubmit).toHaveBeenCalledWith('run-1', { rating: 1, comment: null });
  });

  it('caps the comment at 500 characters', async () => {
    renderControls();
    await userEvent.click(screen.getByRole('button', { name: 'Helpful' }));
    expect(screen.getByLabelText('Comment (optional)')).toHaveAttribute('maxLength', '500');
  });

  it('disables everything while sending', () => {
    const { onSubmit } = renderControls({ status: 'sending', rating: 1 });

    expect(screen.getByRole('button', { name: 'Sending…' })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Helpful' })).toBeDisabled();
    expect(onSubmit).not.toHaveBeenCalled();
  });

  it('thanks the user once sent, with no way to rate again', () => {
    renderControls({ status: 'sent', rating: 1 });

    expect(screen.getByRole('status')).toHaveTextContent('Thanks for your feedback');
    expect(screen.queryByRole('button')).not.toBeInTheDocument();
  });

  it('shows a rating given before this visit, with no way to rate again', () => {
    renderControls({ status: 'rated', rating: -1 });

    expect(screen.getByText(/You rated this answer/)).toBeInTheDocument();
    expect(screen.getByRole('img', { name: 'not helpful' })).toBeInTheDocument();
    expect(screen.queryByRole('button')).not.toBeInTheDocument();
  });

  it('explains a failure and allows a retry', async () => {
    const { onSubmit } = renderControls({
      status: 'failed',
      rating: 1,
      error: { reason: 'NETWORK', retryAfterMs: null },
    });

    expect(screen.getByRole('alert')).toHaveTextContent("Wanderly can't be reached right now.");
    await userEvent.click(screen.getByRole('button', { name: 'Send feedback' }));
    expect(onSubmit).toHaveBeenCalledWith('run-1', { rating: 1, comment: null });
  });
});
