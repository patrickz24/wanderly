import type { OutgoingHttpHeaders } from 'node:http';
import { AgentEventSchema, type AgentEvent } from '@wanderly/contracts';
import type { FastifyBaseLogger, FastifyReply } from 'fastify';
import { INTERNAL_ERROR_MESSAGE } from './errors.js';

/** Comment lines keep proxies and the client's idle timeout from closing a quiet stream. */
export const DEFAULT_HEARTBEAT_MS = 15_000;

export const SSE_HEADERS = {
  'content-type': 'text/event-stream; charset=utf-8',
  'cache-control': 'no-cache',
  // Disables response buffering in nginx (and compatible proxies) for this response.
  'x-accel-buffering': 'no',
} as const;

/** Formats one event: `event:` is the event type, `data:` its JSON on a single line. */
export function formatEvent(event: AgentEvent): string {
  return `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`;
}

/**
 * A Server-Sent Events response over a hijacked Fastify reply. It opens lazily on the first
 * event, so a request that fails before producing anything still gets a normal JSON error.
 * Every event is validated against the contracts before it is written; writes after the client
 * left are dropped.
 */
export class SseStream {
  readonly #reply: FastifyReply;
  readonly #log: FastifyBaseLogger;
  readonly #heartbeatMs: number;
  #heartbeat: ReturnType<typeof setInterval> | undefined;
  #opened = false;

  constructor(
    reply: FastifyReply,
    options: { readonly log: FastifyBaseLogger; readonly heartbeatMs?: number },
  ) {
    this.#reply = reply;
    this.#log = options.log;
    this.#heartbeatMs = options.heartbeatMs ?? DEFAULT_HEARTBEAT_MS;
  }

  get opened(): boolean {
    return this.#opened;
  }

  /** True once the response ended or the client disconnected. */
  get closed(): boolean {
    const raw = this.#reply.raw;
    return raw.destroyed || raw.writableEnded;
  }

  send(event: AgentEvent): void {
    this.#open();
    const parsed = AgentEventSchema.safeParse(event);
    if (parsed.success) {
      this.#write(formatEvent(parsed.data));
      return;
    }
    // A malformed event is a bug: log it and tell the client something went wrong instead.
    this.#log.error({ err: parsed.error, eventType: event.type }, 'invalid SSE event dropped');
    this.#write(
      formatEvent({
        type: 'error',
        runId: 'runId' in event && typeof event.runId === 'string' ? event.runId : null,
        error: { code: 'INTERNAL_ERROR', message: INTERNAL_ERROR_MESSAGE },
      }),
    );
  }

  close(): void {
    clearInterval(this.#heartbeat);
    this.#heartbeat = undefined;
    if (this.#opened && !this.closed) this.#reply.raw.end();
  }

  #open(): void {
    if (this.#opened) return;
    this.#opened = true;
    const reply = this.#reply;
    reply.hijack();
    // Hijacked replies bypass Fastify's serialization: carry over the headers set by hooks
    // (request id, CORS, security headers), then add the stream's own.
    const headers: OutgoingHttpHeaders = {};
    for (const [name, value] of Object.entries(reply.getHeaders())) {
      if (value !== undefined) headers[name] = value;
    }
    reply.raw.writeHead(200, { ...headers, ...SSE_HEADERS });
    this.#heartbeat = setInterval(() => this.#write(': keep-alive\n\n'), this.#heartbeatMs);
    this.#heartbeat.unref();
  }

  #write(chunk: string): void {
    if (this.closed) return;
    this.#reply.raw.write(chunk);
  }
}
