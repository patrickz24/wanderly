import {
  AgentEventSchema,
  type AgentEvent,
  type AgentEventType,
  type SendMessageRequest,
} from '@wanderly/contracts';
import { ApiError, resolveApiUrl, toHttpError } from './api';
import { readSseMessages, type SseMessage } from './sse';

/**
 * Longest silence tolerated on the stream (no event, no heartbeat) before giving up. Above the
 * API's whole-run deadline (90 s by default), so it only fires when the connection is stuck.
 */
export const STREAM_IDLE_TIMEOUT_MS = 120_000;

/** Exhaustive by construction: adding an event type to the contract breaks this object. */
const KNOWN_EVENT_TYPES: Readonly<Record<AgentEventType, true>> = {
  'run.started': true,
  'tool.started': true,
  'tool.finished': true,
  response: true,
  'run.finished': true,
  error: true,
};

function isKnownEventType(name: string): name is AgentEventType {
  return Object.hasOwn(KNOWN_EVENT_TYPES, name);
}

/** Events after which the server sends nothing more for this run. */
function isTerminal(event: AgentEvent): boolean {
  return event.type === 'run.finished' || event.type === 'error';
}

/**
 * Validates one SSE message against the contract.
 *
 * Unknown event names return `null` and are ignored, so the server can add event types without
 * breaking deployed clients. A known event that does not match its schema is a contract
 * violation and throws: showing a half-understood answer would be worse than an error.
 */
export function decodeAgentEvent(message: SseMessage): AgentEvent | null {
  if (!isKnownEventType(message.event)) {
    return null;
  }
  let json: unknown;
  try {
    json = JSON.parse(message.data);
  } catch (error) {
    throw new ApiError('invalid-response', `The "${message.event}" event is not valid JSON.`, {
      cause: error,
    });
  }
  const parsed = AgentEventSchema.safeParse(json);
  if (!parsed.success || parsed.data.type !== message.event) {
    throw new ApiError(
      'invalid-response',
      `The "${message.event}" event does not match the contract.`,
      { cause: parsed.error },
    );
  }
  return parsed.data;
}

export interface StreamAgentRunOptions {
  /** Cancels the run from the client (unmount, new message, "Stop" button). */
  readonly signal: AbortSignal;
  /** Receives each validated event, in order. */
  readonly onEvent: (event: AgentEvent) => void;
  readonly idleTimeoutMs?: number;
}

function buildRequest(text: string, signal: AbortSignal): RequestInit {
  const body: SendMessageRequest = { text };
  return {
    method: 'POST',
    headers: { Accept: 'text/event-stream', 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
    signal,
  };
}

/**
 * `POST /api/conversations/:id/messages` and follows the run's Server-Sent Events.
 *
 * Resolves once a terminal event (`run.finished` or `error`) has been delivered. Rejects with
 * an {@link ApiError} otherwise: `http` when the server refused the message before streaming
 * (e.g. 429 with `Retry-After`), `invalid-response` on a contract violation, `network` when the
 * connection drops before the run ends, `timeout` after {@link STREAM_IDLE_TIMEOUT_MS} of
 * silence, `aborted` when the caller cancels.
 *
 * Never retried automatically: replaying the POST would start a second, billed agent run.
 */
export async function streamAgentRun(
  conversationId: string,
  text: string,
  options: StreamAgentRunOptions,
): Promise<void> {
  const { signal, onEvent, idleTimeoutMs = STREAM_IDLE_TIMEOUT_MS } = options;
  if (signal.aborted) {
    throw new ApiError('aborted', 'The request was cancelled.', { cause: signal.reason });
  }
  const url = resolveApiUrl(`/api/conversations/${encodeURIComponent(conversationId)}/messages`);

  const controller = new AbortController();
  let timedOut = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const armIdleTimer = (): void => {
    clearTimeout(timer);
    timer = setTimeout(() => {
      timedOut = true;
      controller.abort();
    }, idleTimeoutMs);
  };
  const forwardAbort = (): void => {
    controller.abort();
  };
  signal.addEventListener('abort', forwardAbort, { once: true });

  try {
    armIdleTimer();
    const response = await fetch(url, buildRequest(text, controller.signal));
    if (!response.ok) {
      throw toHttpError(response.status, await response.text(), response.headers);
    }
    const contentType = response.headers.get('Content-Type') ?? '';
    if (!contentType.toLowerCase().startsWith('text/event-stream') || response.body === null) {
      throw new ApiError('invalid-response', 'The API did not answer with an event stream.', {
        status: response.status,
      });
    }

    const messages = readSseMessages(response.body, {
      signal: controller.signal,
      onActivity: armIdleTimer,
    });
    for await (const message of messages) {
      const event = decodeAgentEvent(message);
      if (event === null) {
        continue;
      }
      onEvent(event);
      if (isTerminal(event)) {
        return; // Leaving the loop cancels the stream.
      }
    }
    throw new ApiError('network', 'The connection closed before the run finished.');
  } catch (error) {
    if (error instanceof ApiError) {
      throw error;
    }
    if (timedOut) {
      throw new ApiError('timeout', `The stream was silent for ${idleTimeoutMs} ms.`, {
        cause: error,
      });
    }
    if (signal.aborted) {
      throw new ApiError('aborted', 'The request was cancelled.', { cause: error });
    }
    throw new ApiError('network', 'The connection to the API was lost.', { cause: error });
  } finally {
    clearTimeout(timer);
    signal.removeEventListener('abort', forwardAbort);
  }
}
