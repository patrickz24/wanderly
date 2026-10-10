/**
 * Incremental parser for `text/event-stream` (WHATWG HTML, "Server-sent events", §9.2.6).
 *
 * `EventSource` cannot send a POST body, so the chat reads the stream through `fetch` and this
 * parser instead. It follows the specification's line and field rules, which is what makes it
 * robust to arbitrary chunking: a line or a multi-byte character may be split across chunks,
 * lines may end with CRLF, LF or CR, comments (heartbeats) are skipped, and an event is only
 * dispatched on the blank line that ends it.
 */

export interface SseMessage {
  /** The `event:` field, or `"message"` when the event did not name itself. */
  readonly event: string;
  /** Every `data:` line of the event, joined with `\n`. */
  readonly data: string;
  /** Last event id seen on the stream (`id:` field), `""` when none. */
  readonly lastEventId: string;
}

const DEFAULT_EVENT_TYPE = 'message';
const LINE_END = /\r\n|\r|\n/g;
const BYTE_ORDER_MARK = '﻿';

export class SseParser {
  readonly #onMessage: (message: SseMessage) => void;
  /** Text received after the last complete line. */
  #buffer = '';
  /** The previous chunk ended with CR: a LF at the start of the next one belongs to it. */
  #skipLeadingLf = false;
  #started = false;
  #eventType = '';
  #dataLines: string[] = [];
  #lastEventId = '';

  constructor(onMessage: (message: SseMessage) => void) {
    this.#onMessage = onMessage;
  }

  /** Feeds decoded text. Complete events are dispatched synchronously, in order. */
  feed(chunk: string): void {
    let text = chunk;
    if (!this.#started && text !== '') {
      this.#started = true;
      if (text.startsWith(BYTE_ORDER_MARK)) {
        text = text.slice(1);
      }
    }
    if (this.#skipLeadingLf && text !== '') {
      this.#skipLeadingLf = false;
      if (text.startsWith('\n')) {
        text = text.slice(1);
      }
    }
    this.#buffer += text;
    this.#consumeLines();
  }

  /**
   * Ends the stream. Per the specification, an event without its terminating blank line is
   * incomplete and is discarded rather than dispatched.
   */
  end(): void {
    this.#buffer = '';
    this.#eventType = '';
    this.#dataLines = [];
  }

  #consumeLines(): void {
    const buffer = this.#buffer;
    let start = 0;
    LINE_END.lastIndex = 0;
    for (let match = LINE_END.exec(buffer); match !== null; match = LINE_END.exec(buffer)) {
      this.#processLine(buffer.slice(start, match.index));
      start = match.index + match[0].length;
      if (match[0] === '\r' && start === buffer.length) {
        this.#skipLeadingLf = true;
      }
    }
    this.#buffer = buffer.slice(start);
  }

  #processLine(line: string): void {
    if (line === '') {
      this.#dispatch();
      return;
    }
    if (line.startsWith(':')) {
      return; // Comment, typically a keep-alive heartbeat.
    }
    const colon = line.indexOf(':');
    const field = colon === -1 ? line : line.slice(0, colon);
    let value = colon === -1 ? '' : line.slice(colon + 1);
    if (value.startsWith(' ')) {
      value = value.slice(1);
    }
    switch (field) {
      case 'event':
        this.#eventType = value;
        break;
      case 'data':
        this.#dataLines.push(value);
        break;
      case 'id':
        if (!value.includes('\0')) {
          this.#lastEventId = value;
        }
        break;
      default:
        // `retry` and unknown fields are ignored: the chat never reconnects automatically,
        // because replaying a POST would start a second agent run.
        break;
    }
  }

  #dispatch(): void {
    const dataLines = this.#dataLines;
    const eventType = this.#eventType;
    this.#dataLines = [];
    this.#eventType = '';
    if (dataLines.length === 0) {
      return;
    }
    this.#onMessage({
      event: eventType === '' ? DEFAULT_EVENT_TYPE : eventType,
      data: dataLines.join('\n'),
      lastEventId: this.#lastEventId,
    });
  }
}

export interface ReadSseOptions {
  /** Called for every chunk received, heartbeats included (used for idle timeouts). */
  readonly onActivity?: () => void;
  /** Cancels the stream; the iteration then rejects with the signal's reason. */
  readonly signal?: AbortSignal;
}

/**
 * Reads a byte stream as Server-Sent Events. Bytes are decoded as streaming UTF-8, so a
 * character split across two chunks is decoded once both have arrived.
 *
 * Stopping the iteration early (`break`, `return`, an exception in the loop body) cancels the
 * underlying stream. Read errors (network loss) and aborts propagate to the caller.
 */
export async function* readSseMessages(
  stream: ReadableStream<Uint8Array>,
  options: ReadSseOptions = {},
): AsyncGenerator<SseMessage, void, undefined> {
  const { signal, onActivity } = options;
  const reader = stream.getReader();
  const decoder = new TextDecoder('utf-8');
  const pending: SseMessage[] = [];
  const parser = new SseParser((message) => pending.push(message));
  let finished = false;
  // Cancelling settles a pending read even when the body does not observe the signal itself.
  const onAbort = (): void => {
    void reader.cancel(signal?.reason).catch(() => undefined);
  };
  signal?.addEventListener('abort', onAbort, { once: true });

  try {
    signal?.throwIfAborted();
    for (;;) {
      const { done, value } = await reader.read();
      signal?.throwIfAborted();
      onActivity?.();
      if (done) {
        parser.feed(decoder.decode());
        parser.end();
        finished = true;
      } else {
        parser.feed(decoder.decode(value, { stream: true }));
      }
      yield* pending.splice(0);
      if (finished) {
        return;
      }
    }
  } finally {
    signal?.removeEventListener('abort', onAbort);
    if (!finished) {
      // Ignored: the stream may already be errored (e.g. aborted), which is why we are here.
      await reader.cancel().catch(() => undefined);
    }
    reader.releaseLock();
  }
}
