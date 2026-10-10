import { describe, expect, it } from 'vitest';
import { streamOf } from '../test/streams';
import { readSseMessages, SseParser, type SseMessage } from './sse';

function parseAll(chunks: readonly string[]): SseMessage[] {
  const messages: SseMessage[] = [];
  const parser = new SseParser((message) => messages.push(message));
  for (const chunk of chunks) {
    parser.feed(chunk);
  }
  parser.end();
  return messages;
}

/** Every way of cutting `text` in two, to prove the result does not depend on chunking. */
function everySplit(text: string): string[][] {
  return Array.from({ length: text.length + 1 }, (_, i) => [text.slice(0, i), text.slice(i)]);
}

async function collect(
  stream: ReadableStream<Uint8Array>,
  signal?: AbortSignal,
): Promise<SseMessage[]> {
  const messages: SseMessage[] = [];
  for await (const message of readSseMessages(stream, { signal })) {
    messages.push(message);
  }
  return messages;
}

const TWO_EVENTS =
  'event: run.started\ndata: {"a":1}\n\n: heartbeat\n\nevent: response\ndata: {"b":2}\n\n';

describe('SseParser', () => {
  it('dispatches a named event with its data', () => {
    expect(parseAll(['event: tool.started\ndata: {"x":1}\n\n'])).toEqual([
      { event: 'tool.started', data: '{"x":1}', lastEventId: '' },
    ]);
  });

  it('defaults the event name to "message"', () => {
    expect(parseAll(['data: hello\n\n'])).toEqual([
      { event: 'message', data: 'hello', lastEventId: '' },
    ]);
  });

  it('yields the same events whatever the chunk boundaries', () => {
    const expected = parseAll([TWO_EVENTS]);
    expect(expected).toHaveLength(2);

    for (const chunks of everySplit(TWO_EVENTS)) {
      expect(parseAll(chunks)).toEqual(expected);
    }
    expect(parseAll([...TWO_EVENTS])).toEqual(expected); // one character per chunk
  });

  it('joins multi-line data with a line feed', () => {
    expect(parseAll(['data: first\ndata: second\ndata:\ndata: fourth\n\n'])[0]?.data).toBe(
      'first\nsecond\n\nfourth',
    );
  });

  it.each([
    ['CRLF', '\r\n'],
    ['CR', '\r'],
    ['LF', '\n'],
  ])('accepts %s line endings', (_name, eol) => {
    const text = `event: a${eol}data: 1${eol}${eol}event: b${eol}data: 2${eol}${eol}`;
    expect(parseAll([text]).map((m) => [m.event, m.data])).toEqual([
      ['a', '1'],
      ['b', '2'],
    ]);
  });

  it('treats a CRLF split across two chunks as a single line ending', () => {
    // Were the LF counted twice, the blank line would dispatch the event early.
    expect(parseAll(['data: a\r', '\ndata: b\r\n\r\n'])).toEqual([
      { event: 'message', data: 'a\nb', lastEventId: '' },
    ]);
  });

  it('ignores comments and heartbeats', () => {
    expect(parseAll([': ping\n\n:\n\n: keep-alive\ndata: x\n\n'])).toEqual([
      { event: 'message', data: 'x', lastEventId: '' },
    ]);
  });

  it('removes one optional space after the colon, and only one', () => {
    expect(parseAll(['data:no-space\n\n', 'data:  two spaces\n\n']).map((m) => m.data)).toEqual([
      'no-space',
      ' two spaces',
    ]);
  });

  it('treats a line without a colon as a field with an empty value', () => {
    expect(parseAll(['data\n\n'])).toEqual([{ event: 'message', data: '', lastEventId: '' }]);
  });

  it('ignores unknown fields and retry', () => {
    expect(parseAll(['retry: 1000\nfoo: bar\ndata: ok\n\n'])).toEqual([
      { event: 'message', data: 'ok', lastEventId: '' },
    ]);
  });

  it('does not dispatch an event without data, and resets its name', () => {
    expect(parseAll(['event: lonely\n\ndata: next\n\n'])).toEqual([
      { event: 'message', data: 'next', lastEventId: '' },
    ]);
  });

  it('keeps the last event id across events and rejects ids containing NUL', () => {
    const messages = parseAll(['id: 7\ndata: a\n\ndata: b\n\nid: x\0y\ndata: c\n\n']);
    expect(messages.map((m) => m.lastEventId)).toEqual(['7', '7', '7']);
  });

  it('discards an incomplete event at the end of the stream', () => {
    expect(parseAll(['data: complete\n\ndata: cut off'])).toEqual([
      { event: 'message', data: 'complete', lastEventId: '' },
    ]);
  });

  it('strips a leading byte order mark', () => {
    expect(parseAll(['\uFEFFdata: x\n\n'])[0]?.data).toBe('x');
  });
});

describe('readSseMessages', () => {
  const encoder = new TextEncoder();

  it('decodes a multi-byte character split across chunks', async () => {
    const bytes = encoder.encode('data: Città 🌋\n\n');
    // Cut inside "à" (2 bytes) and inside the emoji (4 bytes).
    const cutA = 'data: Citt'.length + 1;
    const cutB = bytes.length - 4;
    const stream = streamOf([bytes.slice(0, cutA), bytes.slice(cutA, cutB), bytes.slice(cutB)]);

    expect(await collect(stream)).toEqual([
      { event: 'message', data: 'Città 🌋', lastEventId: '' },
    ]);
  });

  it('yields events in order across many small chunks', async () => {
    const bytes = encoder.encode(TWO_EVENTS);
    const chunks = Array.from({ length: Math.ceil(bytes.length / 3) }, (_, i) =>
      bytes.slice(i * 3, i * 3 + 3),
    );

    expect((await collect(streamOf(chunks))).map((m) => m.event)).toEqual([
      'run.started',
      'response',
    ]);
  });

  it('reports activity for every chunk, heartbeats included', async () => {
    let activity = 0;
    const stream = streamOf([encoder.encode(': ping\n\n'), encoder.encode('data: x\n\n')]);

    for await (const _message of readSseMessages(stream, { onActivity: () => activity++ })) {
      // drain
    }

    expect(activity).toBe(3); // two chunks, then end of stream
  });

  it('cancels the stream when the consumer stops early', async () => {
    let cancelled = false;
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(encoder.encode('data: 1\n\ndata: 2\n\n'));
      },
      cancel() {
        cancelled = true;
      },
    });

    for await (const message of readSseMessages(stream)) {
      expect(message.data).toBe('1');
      break;
    }

    expect(cancelled).toBe(true);
  });

  it('cancels a silent stream and rejects when the signal aborts', async () => {
    let cancelled = false;
    const stream = new ReadableStream<Uint8Array>({
      cancel() {
        cancelled = true;
      },
    });
    const controller = new AbortController();

    const pending = collect(stream, controller.signal);
    controller.abort();

    await expect(pending).rejects.toMatchObject({ name: 'AbortError' });
    expect(cancelled).toBe(true);
  });

  it('propagates a read error', async () => {
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(encoder.encode('data: 1\n\n'));
        controller.error(new TypeError('network lost'));
      },
    });

    await expect(collect(stream)).rejects.toThrow('network lost');
  });
});
