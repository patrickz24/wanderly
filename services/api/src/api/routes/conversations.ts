import {
  CreateConversationResponseSchema,
  FeedbackRequestSchema,
  GetConversationResponseSchema,
  ListConversationsResponseSchema,
  SendMessageRequestSchema,
  type AgentEvent,
} from '@wanderly/contracts';
import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import { z } from 'zod';
import type {
  CreateConversation,
  GetConversation,
  ListConversations,
} from '../../application/conversations.js';
import type { SendMessage } from '../../application/send-message.js';
import type { SubmitFeedback } from '../../application/submit-feedback.js';
import { mapError } from '../errors.js';
import { useAnonymousSession } from '../session.js';
import { SseStream } from '../sse.js';

export interface ConversationUseCases {
  readonly createConversation: CreateConversation;
  readonly listConversations: ListConversations;
  readonly getConversation: GetConversation;
  readonly sendMessage: SendMessage;
  readonly submitFeedback: SubmitFeedback;
}

export interface RateLimitSettings {
  readonly max: number;
  readonly timeWindow: number;
}

export interface ConversationRoutesOptions {
  readonly useCases: ConversationUseCases;
  /** Limit of the cheap routes (the message route uses the plugin's defaults). */
  readonly apiRateLimit: RateLimitSettings;
  readonly secureCookies: boolean;
  readonly sseHeartbeatMs?: number;
}

const IdParamsSchema = z.object({ id: z.uuid() });

/**
 * The conversation API (plan §10), mounted under `/api`. Every route runs with an anonymous
 * session; a conversation or run of another session answers 404, exactly like a missing one.
 */
export const conversationRoutes: FastifyPluginAsyncZod<ConversationRoutesOptions> = async (
  app,
  { useCases, apiRateLimit, secureCookies, sseHeartbeatMs },
) => {
  useAnonymousSession(app, { secure: secureCookies });
  // Fail closed: without a resolved session, every caller would share the same empty one.
  app.addHook('preHandler', async (request) => {
    if (request.sessionId === '') throw new Error('Anonymous session was not resolved');
  });

  const apiLimit = { rateLimit: apiRateLimit };

  app.post(
    '/conversations',
    { config: apiLimit, schema: { response: { 201: CreateConversationResponseSchema } } },
    async (request, reply) => {
      const summary = await useCases.createConversation.execute({ sessionId: request.sessionId });
      return reply.code(201).send(summary);
    },
  );

  app.get(
    '/conversations',
    { config: apiLimit, schema: { response: { 200: ListConversationsResponseSchema } } },
    async (request) => useCases.listConversations.execute({ sessionId: request.sessionId }),
  );

  app.get(
    '/conversations/:id',
    {
      config: apiLimit,
      schema: { params: IdParamsSchema, response: { 200: GetConversationResponseSchema } },
    },
    async (request) =>
      useCases.getConversation.execute({
        sessionId: request.sessionId,
        conversationId: request.params.id,
      }),
  );

  // Each message starts a paid agent run: this route has the strict per-IP limit
  // (RATE_LIMIT_MAX per RATE_LIMIT_WINDOW_MS), the plugin's defaults.
  app.post(
    '/conversations/:id/messages',
    {
      config: { rateLimit: {} },
      schema: { params: IdParamsSchema, body: SendMessageRequestSchema },
    },
    async (request, reply) => {
      const stream = new SseStream(reply, {
        log: request.log,
        ...(sseHeartbeatMs === undefined ? {} : { heartbeatMs: sseHeartbeatMs }),
      });
      const disconnect = new AbortController();
      const onClose = () => {
        // `close` before the response finished means the client went away.
        if (!reply.raw.writableFinished) disconnect.abort();
      };
      reply.raw.on('close', onClose);
      let runId: string | null = null;

      try {
        const result = await useCases.sendMessage.execute(
          {
            sessionId: request.sessionId,
            conversationId: request.params.id,
            text: request.body.text,
          },
          {
            signal: disconnect.signal,
            emit: (event: AgentEvent) => {
              if (event.type === 'run.started') runId = event.runId;
              stream.send(event);
            },
            log: request.log,
          },
        );
        request.log.info(
          {
            runId: result.runId,
            traceId: result.traceId,
            steps: result.steps,
            costUsd: result.costUsd,
            latencyMs: result.latencyMs,
          },
          'agent run completed',
        );
      } catch (error) {
        // Nothing streamed yet (unknown conversation, turn limit, budget…): a plain JSON error.
        if (!stream.opened) throw error;
        const { body, logLevel } = mapError(error, request.id);
        if (disconnect.signal.aborted) {
          // Expected: the user closed the page or retried. The run is recorded as CANCELLED.
          request.log.info({ err: error, runId }, 'agent run cancelled by the client');
        } else {
          request.log[logLevel]({ err: error, runId }, 'agent run failed');
        }
        stream.send({
          type: 'error',
          runId,
          error: { code: body.error.code, message: body.error.message },
        });
      } finally {
        reply.raw.off('close', onClose);
        stream.close();
      }
    },
  );

  app.post(
    '/runs/:id/feedback',
    { config: apiLimit, schema: { params: IdParamsSchema, body: FeedbackRequestSchema } },
    async (request, reply) => {
      await useCases.submitFeedback.execute({
        sessionId: request.sessionId,
        runId: request.params.id,
        rating: request.body.rating,
        comment: request.body.comment,
      });
      return reply.code(204).send();
    },
  );
};
