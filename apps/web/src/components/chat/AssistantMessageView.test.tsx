import type { AgentResponse } from '@wanderly/contracts';
import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import type { AssistantMessage } from '../../lib/types';
import {
  answerResponse,
  assistantMessage,
  chunkSource,
  clarificationResponse,
  declineResponse,
  itineraryResponse,
  runStats,
} from '../../test/factories';
import { AssistantMessageView } from './AssistantMessageView';

function renderMessage(
  response: AgentResponse,
  options: { message?: Partial<AssistantMessage>; onQuickReply?: (text: string) => void } = {},
) {
  const onFeedback = vi.fn();
  render(
    <AssistantMessageView
      message={assistantMessage(response, options.message)}
      stats={runStats()}
      feedback={undefined}
      onFeedback={onFeedback}
      onQuickReply={options.onQuickReply}
    />,
  );
  return { onFeedback };
}

describe('AssistantMessageView: itinerary', () => {
  it('shows the header with month, duration and travellers', () => {
    renderMessage(itineraryResponse());

    expect(screen.getByRole('article', { name: 'Wanderly: itinerary' })).toBeInTheDocument();
    expect(
      screen.getByRole('heading', { level: 3, name: 'Two quiet days in Sicily' }),
    ).toBeInTheDocument();
    expect(screen.getByText('Forest trails and hill villages.')).toBeInTheDocument();
    expect(screen.getByText('May')).toBeInTheDocument();
    expect(screen.getByText('2 days')).toBeInTheDocument();
    expect(screen.getByText('2 travellers')).toBeInTheDocument();
  });

  it('renders a card per day with slots, justifications and POI badges', () => {
    renderMessage(itineraryResponse());

    const days = within(screen.getByRole('list', { name: 'Days' }));
    expect(days.getAllByRole('heading', { level: 4 })).toHaveLength(2);
    expect(screen.getByRole('heading', { name: 'Day 1 Madonie mountains' })).toBeInTheDocument();
    expect(screen.getByText('Morning')).toBeInTheDocument();
    expect(screen.getByText('Evening')).toBeInTheDocument();
    expect(screen.getByText('Matches your interest in hiking.')).toBeInTheDocument();
    // The POI badge uses the place's name from the run's sources.
    expect(screen.getByText('Point of interest:').parentElement).toHaveTextContent(
      'Point of interest: Madonie Regional Natural Park',
    );
  });

  it('shows an unknown budget honestly, with its notes', () => {
    renderMessage(itineraryResponse());

    const budget = screen.getByRole('heading', { name: 'Budget' }).closest('section');
    expect(budget).not.toBeNull();
    const block = within(budget as HTMLElement);
    expect(block.getByText('Mid-range')).toBeInTheDocument();
    expect(block.getAllByText('Unknown')).toHaveLength(2);
    expect(
      block.getByText('No Sleep listing in the article has a parseable price: value unknown.'),
    ).toBeInTheDocument();
    expect(block.queryByText(/unknown €|EUR/)).not.toBeInTheDocument();
  });

  it('formats a known budget in the currency as given', () => {
    const response = itineraryResponse();
    const withPrices: AgentResponse = {
      ...response,
      itinerary: {
        ...response.itinerary,
        budget: { ...response.itinerary.budget!, currency: '€', total: 1240, perPerson: 620 },
      },
    };
    renderMessage(withPrices);

    expect(screen.getByText('1,240 €')).toBeInTheDocument();
    expect(screen.getByText('620 €')).toBeInTheDocument();
  });

  it('credits Open-Meteo next to the weather', () => {
    renderMessage(itineraryResponse());

    const weather = screen.getByRole('heading', { name: 'Weather in May' }).closest('section');
    expect(
      within(weather as HTMLElement).getByRole('link', { name: /Weather data by Open-Meteo.com/ }),
    ).toHaveAttribute('href', 'https://open-meteo.com/');
  });

  it('lists assumptions and warnings', () => {
    renderMessage(itineraryResponse());

    expect(screen.getByRole('heading', { name: 'Assumptions' })).toBeInTheDocument();
    expect(screen.getByText('2 travellers assumed.')).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: 'Warnings' })).toBeInTheDocument();
    expect(screen.getByText('Trail signage varies: carry a GPS map.')).toBeInTheDocument();
  });
});

describe('AssistantMessageView: citations', () => {
  it('opens the transparency panel on the cited source', async () => {
    renderMessage(itineraryResponse());
    const panel = screen.getByText('Sources and tools').closest('details');
    expect(panel).not.toHaveAttribute('open');

    // Source 2 is the Madonie POI (sources are numbered in the order the API lists them).
    const [chip] = screen.getAllByRole('button', {
      name: 'Source 2: Madonie Regional Natural Park (place)',
    });
    await userEvent.click(chip!);

    expect(panel).toHaveAttribute('open');
    const target = document.activeElement;
    expect(target?.tagName).toBe('LI');
    expect(target).toHaveTextContent('2.Madonie Regional Natural Park');
  });

  it('marks a reference missing from the sources instead of hiding it', () => {
    renderMessage(answerResponse(), { message: { sources: [] } });
    expect(screen.getByText('Unlisted source')).toBeInTheDocument();
  });
});

describe('AssistantMessageView: other types', () => {
  it('renders an answer with its source chips', () => {
    renderMessage(answerResponse());

    expect(screen.getByRole('article', { name: 'Wanderly: answer' })).toBeInTheDocument();
    expect(screen.getByText('The Madonie park has village-to-village hikes.')).toBeInTheDocument();
    expect(
      screen.getByRole('button', { name: `Source 1: ${chunkSource.title} (guide excerpt)` }),
    ).toBeInTheDocument();
  });

  it('renders clarification questions with one-click quick replies', async () => {
    const onQuickReply = vi.fn();
    renderMessage(
      clarificationResponse([
        'How many days will you have?',
        'What budget level do you have in mind (budget, mid or comfort)?',
      ]),
      { onQuickReply },
    );

    expect(screen.getByText('How many days will you have?')).toBeInTheDocument();
    expect(screen.queryByRole('group', { name: 'Quick replies to question 1' })).toBeNull();
    const replies = screen.getByRole('group', { name: 'Quick replies to question 2' });
    await userEvent.click(within(replies).getByRole('button', { name: 'Mid' }));

    expect(onQuickReply).toHaveBeenCalledExactlyOnceWith('Mid');
  });

  it('hides quick replies when replying is not possible', () => {
    renderMessage(clarificationResponse(['Are you travelling with children?']));
    expect(screen.queryByRole('button', { name: 'Yes' })).not.toBeInTheDocument();
  });

  it.each([
    ['out_of_scope', 'Outside what Wanderly does'],
    ['unknown_destination', 'Destination not in the guide'],
    ['insufficient_data', 'Not enough information'],
    ['unsafe', "Can't help with this request"],
  ] as const)('explains a %s decline calmly', (reason, title) => {
    renderMessage(declineResponse(reason));

    expect(screen.getByRole('article', { name: 'Wanderly: declined' })).toBeInTheDocument();
    expect(screen.getByText(title)).toBeInTheDocument();
    expect(screen.getByText('I can only plan trips.')).toBeInTheDocument();
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  });
});
