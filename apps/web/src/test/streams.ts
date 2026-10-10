import type { AgentEvent } from '@wanderly/contracts';

const encoder = new TextEncoder();

/** A byte stream that emits the given chunks, then closes. */
export function streamOf(chunks: readonly (Uint8Array | string)[]): ReadableStream<Uint8Array> {
  return new ReadableStream<Uint8Array>({
    start(controller) {
      for (const chunk of chunks) {
        controller.enqueue(typeof chunk === 'string' ? encoder.encode(chunk) : chunk);
      }
      controller.close();
    },
  });
}

/** Serialises one agent event the way the API does. */
export function sseFrame(event: AgentEvent): string {
  return `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`;
}

/** A 200 `text/event-stream` response whose body emits `chunks` and closes. */
export function sseResponse(chunks: readonly (Uint8Array | string)[]): Response {
  return new Response(streamOf(chunks), {
    status: 200,
    headers: { 'Content-Type': 'text/event-stream; charset=utf-8' },
  });
}

/**
 * A controllable SSE response: push frames over time, close or fail the stream, and observe
 * whether the client cancelled it.
 */
export function controllableSseResponse() {
  let streamController: ReadableStreamDefaultController<Uint8Array> | undefined;
  let cancelled = false;
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      streamController = controller;
    },
    cancel() {
      cancelled = true;
    },
  });
  const controller = (): ReadableStreamDefaultController<Uint8Array> => {
    if (streamController === undefined) {
      throw new Error('stream not started');
    }
    return streamController;
  };
  return {
    response: new Response(body, {
      status: 200,
      headers: { 'Content-Type': 'text/event-stream' },
    }),
    push(text: string) {
      controller().enqueue(encoder.encode(text));
    },
    emit(event: AgentEvent) {
      controller().enqueue(encoder.encode(sseFrame(event)));
    },
    close() {
      controller().close();
    },
    get cancelled() {
      return cancelled;
    },
  };
}
