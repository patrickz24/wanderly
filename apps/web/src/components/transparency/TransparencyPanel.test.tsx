import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import {
  budgetSource,
  chunkSource,
  failedCall,
  runStats,
  weatherCall,
  weatherSource,
} from '../../test/factories';
import { TransparencyPanel } from './TransparencyPanel';

function renderPanel(overrides: Partial<Parameters<typeof TransparencyPanel>[0]> = {}) {
  render(
    <TransparencyPanel
      id="panel"
      sources={[chunkSource, weatherSource, budgetSource]}
      toolCalls={[weatherCall, failedCall]}
      stats={runStats({ traceId: 'trace-123' })}
      open
      onOpenChange={vi.fn()}
      focusRequest={null}
      {...overrides}
    />,
  );
}

function sourceItem(number: number): HTMLElement {
  const item = document.getElementById(`panel-source-${number}`);
  expect(item).not.toBeNull();
  return item as HTMLElement;
}

describe('TransparencyPanel', () => {
  it('summarises what it contains', () => {
    renderPanel();
    expect(screen.getByText('3 sources · 2 tool calls')).toBeInTheDocument();
  });

  it('shows each source with title, snippet and destination', () => {
    renderPanel();

    const item = within(sourceItem(1));
    expect(item.getByText(chunkSource.title)).toBeInTheDocument();
    expect(item.getByText(chunkSource.snippet!)).toBeInTheDocument();
    expect(item.getByText('Guide excerpt · Sicily')).toBeInTheDocument();
  });

  it('links Wikivoyage sources to their revision with the CC BY-SA 4.0 attribution', () => {
    renderPanel();

    const item = within(sourceItem(1));
    const revision = item.getByRole('link', { name: /Wikivoyage revision/ });
    expect(revision).toHaveAttribute('href', chunkSource.url);
    expect(revision).toHaveAttribute('target', '_blank');
    expect(revision).toHaveAttribute('rel', 'noopener noreferrer');
    expect(item.getByRole('link', { name: /CC BY-SA 4.0/ })).toHaveAttribute(
      'href',
      'https://creativecommons.org/licenses/by-sa/4.0/deed.en',
    );
  });

  it('credits Open-Meteo on weather sources', () => {
    renderPanel();
    expect(
      within(sourceItem(2)).getByRole('link', { name: /Weather data by Open-Meteo.com/ }),
    ).toHaveAttribute('href', 'https://open-meteo.com/');
  });

  it('never renders a non-http link', () => {
    renderPanel({ sources: [{ ...chunkSource, url: 'javascript:alert(1)' }] });
    expect(within(sourceItem(1)).queryByRole('link')).not.toBeInTheDocument();
  });

  it('lists tool calls with status, duration, summary and a collapsible JSON input', async () => {
    renderPanel();

    const calls = screen.getByRole('heading', { name: 'Tool calls' }).closest('section');
    const [ok, failed] = within(calls as HTMLElement).getAllByRole('listitem');
    expect(ok).toHaveTextContent('get_seasonal_weather');
    expect(ok).toHaveTextContent('OK');
    expect(ok).toHaveTextContent('38 ms');
    expect(ok).toHaveTextContent('Checking May weather in Sicily');
    expect(failed).toHaveTextContent('Error');
    expect(failed).toHaveTextContent('5.0 s');
    expect(failed).toHaveTextContent('Timed out after 5 s');

    const input = within(ok!).getByText('Input').closest('details');
    expect(input).not.toHaveAttribute('open');
    expect(input).toHaveTextContent('"destinationId": "sicily"');
    await userEvent.click(within(ok!).getByText('Input'));
    expect(input).toHaveAttribute('open');
  });

  it('shows the run footer: steps, tokens, cost and latency', () => {
    renderPanel();

    const footer = screen.getByRole('heading', { name: 'Run' }).closest('section');
    expect(footer).toHaveTextContent('Steps4');
    expect(footer).toHaveTextContent('Tokens12,000 in · 1,500 out · 8,000 cached');
    expect(footer).toHaveTextContent('Cost$0.0215');
    expect(footer).toHaveTextContent('Latency15.4 s');
    expect(footer).toHaveTextContent('Trace reference trace-123');
  });

  it('says when run statistics are not available', () => {
    renderPanel({ stats: undefined });
    expect(
      screen.getByText('Run statistics are only available for answers produced during this visit.'),
    ).toBeInTheDocument();
  });

  it('labels demo statistics as illustrative', () => {
    renderPanel({ illustrativeStats: true });
    expect(
      screen.getByText('Illustrative values (demo mode), not measurements.'),
    ).toBeInTheDocument();
  });

  it('reports the toggle state to its owner', async () => {
    const onOpenChange = vi.fn();
    renderPanel({ open: false, onOpenChange });

    await userEvent.click(screen.getByText('Sources and tools'));

    expect(onOpenChange).toHaveBeenLastCalledWith(true);
  });
});
