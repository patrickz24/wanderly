import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { hangingFetch, jsonResponse, stubFetch } from '../test/fetch';
import { ApiStatusIndicator } from './ApiStatusIndicator';

describe('ApiStatusIndicator', () => {
  it('announces "checking" first, then "online" when /health answers ok', async () => {
    const fetchMock = stubFetch(async () => jsonResponse({ status: 'ok' }));

    render(<ApiStatusIndicator />);

    const status = screen.getByRole('status');
    expect(status).toHaveAttribute('aria-live', 'polite');
    expect(status).toHaveTextContent('Checking API…');
    expect(await screen.findByText('API online')).toBeInTheDocument();
    expect(fetchMock).toHaveBeenCalledWith('/health', expect.anything());
  });

  it('shows "unavailable" when the API cannot be reached', async () => {
    stubFetch(async () => {
      throw new TypeError('Failed to fetch');
    });

    render(<ApiStatusIndicator />);

    expect(await screen.findByText('API unavailable')).toBeInTheDocument();
    expect(screen.getByRole('status')).toHaveTextContent('API unavailable(unreachable)');
  });

  it('shows "unavailable" with the status code on a non-2xx response', async () => {
    stubFetch(async () => new Response('Service Unavailable', { status: 503 }));

    render(<ApiStatusIndicator />);

    expect(await screen.findByText('(HTTP 503)')).toBeInTheDocument();
    expect(screen.getByRole('status')).toHaveTextContent('API unavailable');
  });

  it('keeps polling and recovers when the API comes back', async () => {
    const fetchMock = stubFetch(async () => jsonResponse({ status: 'ok' }));
    fetchMock.mockRejectedValueOnce(new TypeError('Failed to fetch'));

    render(<ApiStatusIndicator pollIntervalMs={10} />);

    expect(await screen.findByText('API unavailable')).toBeInTheDocument();
    expect(await screen.findByText('API online')).toBeInTheDocument();
    expect(fetchMock.mock.calls.length).toBeGreaterThanOrEqual(2);
  });

  it('cancels the in-flight check when unmounted', () => {
    const fetchMock = stubFetch(hangingFetch);

    const { unmount } = render(<ApiStatusIndicator />);
    const signal = fetchMock.mock.calls[0]![1]?.signal;
    expect(signal?.aborted).toBe(false);

    unmount();

    expect(signal?.aborted).toBe(true);
  });
});
