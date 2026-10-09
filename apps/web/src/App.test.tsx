import { render, screen, within } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { App } from './App';

describe('App shell', () => {
  it('exposes the banner and main landmarks', () => {
    render(<App />);

    const banner = screen.getByRole('banner');
    expect(within(banner).getByRole('heading', { level: 1, name: 'Wanderly' })).toBeInTheDocument();
    expect(screen.getByRole('main')).toHaveAttribute('id', 'main');
  });

  it('shows the demo and privacy notice', () => {
    render(<App />);

    const notice = screen.getByRole('complementary', { name: 'Demo notice' });
    expect(notice).toHaveTextContent(
      'Personal demo project — fictional brand. Do not enter personal information. Conversations are stored for 30 days.',
    );
  });

  it('reserves labelled regions for the chat and the itinerary', () => {
    render(<App />);

    const main = screen.getByRole('main');
    expect(within(main).getByRole('region', { name: 'Conversation' })).toBeInTheDocument();
    expect(within(main).getByRole('region', { name: 'Itinerary and sources' })).toBeInTheDocument();
  });

  it('offers a skip link to the main content', () => {
    render(<App />);

    expect(screen.getByRole('link', { name: 'Skip to main content' })).toHaveAttribute(
      'href',
      '#main',
    );
  });
});
