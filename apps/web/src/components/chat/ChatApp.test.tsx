import type { AgentEvent } from '@wanderly/contracts';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';
import { httpTransport } from '../../lib/chatApi';
import { jsonResponse } from '../../test/fetch';
import { callsTo, routeFetch } from '../../test/fetchRouter';
import {
  assistantMessage,
  clarificationResponse,
  conversationDetail,
  conversationSummary,
  ids,
  NOW,
  runFinished,
  weatherCall,
} from '../../test/factories';
import { controllableSseResponse } from '../../test/streams';
import { ChatApp } from './ChatApp';

const LIST = 'GET /api/conversations';
const CREATE = 'POST /api/conversations';
const DETAIL = `GET /api/conversations/${ids.conversation}`;
const SEND = `POST /api/conversations/${ids.conversation}/messages`;
const FEEDBACK = `POST /api/runs/${ids.run}/feedback`;

const runStarted: AgentEvent = {
  type: 'run.started',
  runId: ids.run,
  conversationId: ids.conversation,
  userMessageId: ids.userMessage,
};

function renderChat() {
  render(<ChatApp transport={httpTransport} />);
}

const composer = () => screen.getByRole('textbox', { name: 'Message' });
const trips = () => screen.getByRole('navigation', { name: 'Your trips' });

describe('ChatApp: trips', () => {
  it('lists the session trips, most recent first, and resumes one', async () => {
    const older = conversationSummary({
      id: ids.otherConversation,
      title: 'Crete in June',
      updatedAt: '2026-10-01T09:00:00.000Z',
    });
    const fetchMock = routeFetch({
      [LIST]: () => jsonResponse({ conversations: [older, conversationSummary()] }),
      [DETAIL]: () => jsonResponse(conversationDetail()),
    });
    renderChat();

    const buttons = await within(trips()).findAllByRole('button', { name: /Sicily|Crete/ });
    expect(buttons.map((b) => b.textContent)).toEqual([
      expect.stringContaining('Quiet hiking in Sicily'),
      expect.stringContaining('Crete in June'),
    ]);

    await userEvent.click(buttons[0]!);

    expect(await screen.findByText('Hiking in Sicily?')).toBeInTheDocument();
    expect(screen.getByRole('article', { name: 'Wanderly: answer' })).toBeInTheDocument();
    expect(
      screen.getByRole('heading', { level: 2, name: 'Quiet hiking in Sicily' }),
    ).toBeInTheDocument();
    expect(buttons[0]).toHaveAttribute('aria-current', 'page');
    // Keyboard and screen reader users land on the conversation they opened.
    expect(screen.getByRole('heading', { level: 2, name: 'Quiet hiking in Sicily' })).toHaveFocus();
    expect(callsTo(fetchMock, DETAIL)).toHaveLength(1);
  });

  it('shows an empty list for a new session', async () => {
    routeFetch({ [LIST]: () => jsonResponse({ conversations: [] }) });
    renderChat();

    expect(await within(trips()).findByText(/No trips yet/)).toBeInTheDocument();
  });

  it('offers a retry when the list cannot be loaded', async () => {
    let attempts = 0;
    routeFetch({
      [LIST]: () => {
        attempts += 1;
        if (attempts === 1) {
          throw new TypeError('Failed to fetch');
        }
        return jsonResponse({ conversations: [conversationSummary()] });
      },
    });
    renderChat();

    const alert = await within(trips()).findByRole('alert');
    expect(alert).toHaveTextContent("Wanderly can't be reached right now.");
    await userEvent.click(within(alert).getByRole('button', { name: 'Retry' }));

    expect(await within(trips()).findByText('Quiet hiking in Sicily')).toBeInTheDocument();
  });

  it('explains a trip that no longer exists', async () => {
    routeFetch({
      [LIST]: () => jsonResponse({ conversations: [conversationSummary()] }),
      [DETAIL]: () =>
        jsonResponse({ error: { code: 'NOT_FOUND', message: 'Conversation not found' } }, 404),
    });
    renderChat();

    await userEvent.click(await within(trips()).findByText('Quiet hiking in Sicily'));

    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent('This trip is no longer available.');
    expect(alert).not.toHaveTextContent('Conversation not found');
    await userEvent.click(within(alert).getByRole('button', { name: 'Start a new trip' }));
    expect(screen.getByRole('heading', { level: 2, name: 'New trip' })).toBeInTheDocument();
  });
});

describe('ChatApp: sending', () => {
  it('streams a run: optimistic message, live timeline, answer, then statistics', async () => {
    const stream = controllableSseResponse();
    const fetchMock = routeFetch({
      [LIST]: () => jsonResponse({ conversations: [] }),
      [CREATE]: () => jsonResponse(conversationSummary({ title: null }), 201),
      [SEND]: () => stream.response,
    });
    renderChat();

    await userEvent.type(composer(), 'Hiking in Sicily in May{Enter}');

    // Shown at once, before the server confirms it.
    expect(screen.getByText('Hiking in Sicily in May')).toBeInTheDocument();
    expect(composer()).toHaveValue('');
    await waitFor(() => expect(callsTo(fetchMock, SEND)).toHaveLength(1));
    expect(callsTo(fetchMock, SEND)[0]?.body).toBe('{"text":"Hiking in Sicily in May"}');

    stream.emit(runStarted);
    stream.emit({
      type: 'tool.started',
      runId: ids.run,
      callId: weatherCall.callId,
      name: weatherCall.name,
      input: weatherCall.input,
    });
    const steps = await screen.findByRole('list', { name: 'Steps' });
    expect(within(steps).getByText('Checking May weather in Sicily')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Stop' })).toBeInTheDocument();

    stream.emit({ type: 'tool.finished', runId: ids.run, call: weatherCall });
    stream.emit({ type: 'response', runId: ids.run, message: assistantMessage() });
    expect(await screen.findByRole('article', { name: 'Wanderly: answer' })).toBeInTheDocument();

    stream.emit(runFinished());
    await waitFor(() =>
      expect(screen.queryByRole('region', { name: 'Agent progress' })).not.toBeInTheDocument(),
    );
    expect(screen.getByRole('heading', { name: 'Run' }).closest('section')).toHaveTextContent(
      'Cost$0.0215',
    );
    expect(screen.getByRole('button', { name: 'Send' })).toBeInTheDocument();
    // The trip list is refreshed, since the run may have created or renamed a trip.
    await waitFor(() => expect(callsTo(fetchMock, LIST).length).toBeGreaterThanOrEqual(2));
  });

  it('gives the text back and says how long to wait when rate limited', async () => {
    routeFetch({
      [LIST]: () => jsonResponse({ conversations: [conversationSummary()] }),
      [DETAIL]: () => jsonResponse(conversationDetail()),
      [SEND]: () => {
        const response = jsonResponse(
          { error: { code: 'RATE_LIMITED', message: 'Rate limit exceeded, retry in 42 seconds' } },
          429,
        );
        response.headers.set('Retry-After', '42');
        return response;
      },
    });
    renderChat();
    await userEvent.click(await within(trips()).findByText('Quiet hiking in Sicily'));
    await screen.findByText('Hiking in Sicily?');

    await userEvent.type(composer(), 'And in June?{Enter}');

    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent('Too many requests');
    expect(alert).toHaveTextContent('Please wait about 42 seconds before sending another message.');
    expect(screen.queryByText('And in June?', { ignore: 'textarea' })).not.toBeInTheDocument();
    expect(composer()).toHaveValue('And in June?');
  });

  it('keeps an accepted message and explains an in-stream error', async () => {
    const stream = controllableSseResponse();
    routeFetch({
      [LIST]: () => jsonResponse({ conversations: [] }),
      [CREATE]: () => jsonResponse(conversationSummary({ title: null }), 201),
      [SEND]: () => stream.response,
    });
    renderChat();

    await userEvent.type(composer(), 'Plan Sicily{Enter}');
    await waitFor(() => expect(stream.cancelled).toBe(false));
    stream.emit(runStarted);
    stream.emit({
      type: 'error',
      runId: ids.run,
      error: { code: 'BUDGET_EXCEEDED', message: 'daily_budget_exceeded: 2.01 > 2' },
    });

    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent("The demo's daily budget is used up. Back tomorrow!");
    expect(alert).not.toHaveTextContent('2.01');
    expect(screen.getByText('Plan Sicily')).toBeInTheDocument();
    expect(composer()).toHaveValue('');
  });

  it('stops a run on demand', async () => {
    const stream = controllableSseResponse();
    routeFetch({
      [LIST]: () => jsonResponse({ conversations: [] }),
      [CREATE]: () => jsonResponse(conversationSummary({ title: null }), 201),
      [SEND]: () => stream.response,
    });
    renderChat();

    await userEvent.type(composer(), 'Plan Sicily{Enter}');
    stream.emit(runStarted);
    await screen.findByText('Thinking…');

    await userEvent.click(screen.getByRole('button', { name: 'Stop' }));

    expect(
      await screen.findByText('Stopped. The answer to your last message was cancelled.'),
    ).toBeInTheDocument();
    expect(stream.cancelled).toBe(true);
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  });

  it('puts an example prompt in the composer without sending it', async () => {
    const fetchMock = routeFetch({ [LIST]: () => jsonResponse({ conversations: [] }) });
    renderChat();

    await userEvent.click(screen.getByRole('button', { name: /A week in Sicily in May/ }));

    expect(composer()).toHaveValue(
      'A week in Sicily in May, mid budget, we love hiking and want to avoid tourist traps',
    );
    expect(composer()).toHaveFocus();
    expect(callsTo(fetchMock, CREATE)).toHaveLength(0);
  });

  it('sends a quick reply in one click', async () => {
    const stream = controllableSseResponse();
    const detail = conversationDetail({
      messages: [
        { id: ids.userMessage, role: 'user', text: 'Sicily trip', createdAt: NOW },
        assistantMessage(
          clarificationResponse([
            'What budget level do you have in mind (budget, mid or comfort)?',
          ]),
        ),
      ],
    });
    const fetchMock = routeFetch({
      [LIST]: () => jsonResponse({ conversations: [conversationSummary()] }),
      [DETAIL]: () => jsonResponse(detail),
      [SEND]: () => stream.response,
    });
    renderChat();
    await userEvent.click(await within(trips()).findByText('Quiet hiking in Sicily'));

    await userEvent.click(await screen.findByRole('button', { name: 'Comfort' }));

    await waitFor(() => expect(callsTo(fetchMock, SEND)).toHaveLength(1));
    expect(callsTo(fetchMock, SEND)[0]?.body).toBe('{"text":"Comfort"}');
    // No second quick reply while the run is in flight.
    expect(screen.queryByRole('button', { name: 'Budget' })).not.toBeInTheDocument();
  });
});

describe('ChatApp: feedback', () => {
  it('posts feedback once per run', async () => {
    const fetchMock = routeFetch({
      [LIST]: () => jsonResponse({ conversations: [conversationSummary()] }),
      [DETAIL]: () => jsonResponse(conversationDetail()),
      [FEEDBACK]: () => new Response(null, { status: 204 }),
    });
    renderChat();
    await userEvent.click(await within(trips()).findByText('Quiet hiking in Sicily'));

    await userEvent.click(await screen.findByRole('button', { name: 'Helpful' }));
    await userEvent.type(screen.getByLabelText('Comment (optional)'), 'Great sources');
    const send = screen.getByRole('button', { name: 'Send feedback' });
    await userEvent.dblClick(send);

    expect(await screen.findByText(/Thanks for your feedback/)).toBeInTheDocument();
    const posts = callsTo(fetchMock, FEEDBACK);
    expect(posts).toHaveLength(1);
    expect(posts[0]?.body).toBe('{"rating":1,"comment":"Great sources"}');
    expect(screen.queryByRole('button', { name: 'Helpful' })).not.toBeInTheDocument();
  });
});
