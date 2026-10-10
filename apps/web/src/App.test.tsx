import { render, screen, within } from '@testing-library/react';
import { beforeEach, describe, expect, it } from 'vitest';
import { App } from './App';
import { createDemoTransport } from './demo/demoTransport';
import { DEMO_IDS } from './demo/fixtures';
import { hangingFetch, stubFetch } from './test/fetch';

describe('App shell', () => {
  beforeEach(() => {
    // The header polls /health and the trip list loads; keep both pending: these tests are
    // about the layout.
    stubFetch(hangingFetch);
  });

  it('exposes the banner, main and contentinfo landmarks', () => {
    render(<App />);

    const banner = screen.getByRole('banner');
    expect(within(banner).getByRole('heading', { level: 1, name: 'Wanderly' })).toBeInTheDocument();
    expect(screen.getByRole('main')).toHaveAttribute('id', 'main');
    expect(screen.getByRole('contentinfo')).toHaveTextContent('CC BY-SA 4.0');
  });

  it('shows the API status in the header', () => {
    render(<App />);

    expect(within(screen.getByRole('banner')).getByRole('status')).toHaveTextContent(
      'Checking API…',
    );
  });

  it('shows the demo and privacy notice', () => {
    render(<App />);

    const notice = screen.getByRole('complementary', { name: 'Demo notice' });
    expect(notice).toHaveTextContent(
      'Personal demo project — fictional brand. Do not enter personal information. Conversations are stored for 30 days.',
    );
  });

  it('opens on a new trip with the trip list and example prompts', () => {
    render(<App />);

    const main = screen.getByRole('main');
    expect(within(main).getByRole('navigation', { name: 'Your trips' })).toBeInTheDocument();
    expect(within(main).getByRole('region', { name: 'New trip' })).toBeInTheDocument();
    expect(within(main).getByText('Try an example')).toBeInTheDocument();
    expect(within(main).getByRole('textbox', { name: 'Message' })).toBeInTheDocument();
  });

  it('offers a skip link to the main content', () => {
    render(<App />);

    expect(screen.getByRole('link', { name: 'Skip to main content' })).toHaveAttribute(
      'href',
      '#main',
    );
  });
});

describe('App in demo mode', () => {
  it('renders the sample trip without calling the API', async () => {
    const fetchMock = stubFetch(hangingFetch);
    render(
      <App
        demo
        transport={createDemoTransport({ speed: 0 })}
        initialConversationId={DEMO_IDS.hikingTrip}
      />,
    );

    expect(
      await screen.findByRole('heading', { level: 3, name: 'Five quiet hiking days in Sicily' }),
    ).toBeInTheDocument();
    expect(screen.getByRole('complementary', { name: 'Demo mode' })).toHaveTextContent(
      'Demo mode: sample data.',
    );
    expect(within(screen.getByRole('banner')).getByText('Demo mode (offline)')).toBeInTheDocument();
    expect(
      screen.getByRole('article', { name: 'Wanderly: follow-up questions' }),
    ).toBeInTheDocument();
    expect(screen.getByRole('article', { name: 'Wanderly: declined' })).toBeInTheDocument();
    // Nothing in demo mode was measured, so no figure is shown: no run footer, no durations.
    expect(screen.queryAllByRole('heading', { name: 'Run' })).toHaveLength(0);
    expect(screen.queryByText(/^\d+(\.\d+)? (ms|s)$/)).not.toBeInTheDocument();
    expect(screen.queryByText(/^\$\d/)).not.toBeInTheDocument();
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
