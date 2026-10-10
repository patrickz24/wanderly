import { randomBytes } from 'node:crypto';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';

declare module 'fastify' {
  interface FastifyRequest {
    /** Anonymous browser session (from the signed `wanderly_sid` cookie). */
    sessionId: string;
  }
}

export const SESSION_COOKIE = 'wanderly_sid';
/** Conversations are purged after 30 days, so the session lives as long. */
export const SESSION_MAX_AGE_SECONDS = 30 * 24 * 60 * 60;
/** 32 random bytes, base64url: 256 bits, not guessable. */
const SESSION_ID_PATTERN = /^[A-Za-z0-9_-]{43}$/;

export function newSessionId(): string {
  return randomBytes(32).toString('base64url');
}

export interface SessionOptions {
  /** `Secure` cookie attribute (production, behind HTTPS). */
  readonly secure: boolean;
}

/**
 * Anonymous sessions: every API request gets a session id from a signed, httpOnly cookie, created
 * on first use. The signature (SESSION_SECRET) stops a client from choosing another session's id;
 * the id itself is random, so it cannot be guessed either. There are no accounts: the session
 * only scopes which conversations a browser can see.
 */
export function sessionHook({ secure }: SessionOptions) {
  return async function resolveSession(request: FastifyRequest, reply: FastifyReply) {
    const raw = request.cookies[SESSION_COOKIE];
    if (raw !== undefined) {
      const { valid, value } = request.unsignCookie(raw);
      if (valid && value !== null && SESSION_ID_PATTERN.test(value)) {
        request.sessionId = value;
        return;
      }
      // Tampered, forged or signed with a rotated secret: start a fresh session.
      request.log.warn('invalid session cookie, issuing a new session');
    }
    request.sessionId = newSessionId();
    reply.setCookie(SESSION_COOKIE, request.sessionId, {
      signed: true,
      httpOnly: true,
      sameSite: 'lax',
      secure,
      path: '/api',
      maxAge: SESSION_MAX_AGE_SECONDS,
    });
  };
}

/**
 * Adds the session to every route of `app`'s scope. Call it in the plugin that declares the
 * routes: hooks are encapsulated, so a separate child plugin would not reach them.
 */
export function useAnonymousSession(app: FastifyInstance, options: SessionOptions): void {
  app.decorateRequest('sessionId', '');
  app.addHook('onRequest', sessionHook(options));
}
