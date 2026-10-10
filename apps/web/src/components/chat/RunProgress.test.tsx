import { render, screen, within } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import type { ActiveRun } from '../../state/chatReducer';
import { RunProgress } from './RunProgress';

function run(overrides: Partial<ActiveRun> = {}): ActiveRun {
  return {
    clientRunId: 'run-1',
    runId: 'server-run',
    userMessageId: 'm1',
    tools: [],
    responded: false,
    ...overrides,
  };
}

describe('RunProgress', () => {
  it('says the message is being sent until the run starts', () => {
    render(<RunProgress run={run({ runId: null })} />);
    expect(screen.getByRole('status')).toHaveTextContent('Sending your message…');
  });

  it('announces each tool step with a human label in a polite live region', () => {
    render(
      <RunProgress
        run={run({
          tools: [
            {
              callId: 'a',
              name: 'search_knowledge',
              input: { query: 'quiet hikes' },
              status: 'ok',
              durationMs: 412,
              summary: '6 excerpts',
            },
            {
              callId: 'b',
              name: 'get_seasonal_weather',
              input: { destinationId: 'sicily', month: 5 },
              status: 'running',
              durationMs: null,
              summary: null,
            },
          ],
        })}
      />,
    );

    const steps = screen.getByRole('list', { name: 'Steps' });
    expect(steps).toHaveAttribute('aria-live', 'polite');
    const items = within(steps).getAllByRole('listitem');
    expect(items[0]).toHaveTextContent('Searching the guide for “quiet hikes”done in 412 ms');
    expect(items[1]).toHaveTextContent('Checking May weather in Sicilyin progress');
    expect(screen.getByRole('status')).toHaveTextContent('Working on it…');
  });

  it('shows failed tools honestly, with their summary', () => {
    render(
      <RunProgress
        run={run({
          tools: [
            {
              callId: 'a',
              name: 'estimate_budget',
              input: {},
              status: 'error',
              durationMs: 5000,
              summary: 'Timed out after 5 s',
            },
          ],
        })}
      />,
    );

    const item = screen.getByRole('listitem');
    expect(item).toHaveTextContent('Estimating the budget');
    expect(item).toHaveTextContent('failed after 5.0 s');
    expect(item).toHaveTextContent('Timed out after 5 s');
  });

  it('says it is wrapping up once the answer has arrived', () => {
    render(<RunProgress run={run({ responded: true })} />);
    expect(screen.getByRole('status')).toHaveTextContent('Wrapping up…');
  });
});
