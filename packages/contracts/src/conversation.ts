import { z } from 'zod';
import { AgentResponseSchema, SourceKindSchema, TripBriefSchema } from './agent.js';
import { ApiErrorCodeSchema } from './errors.js';

/**
 * HTTP contracts of the conversation API and the Server-Sent Events emitted while the agent runs.
 * Display-level only: the provider's raw message blocks (thinking, tool calls) stay server-side.
 */

const uuid = z.uuid();
const timestamp = z.iso.datetime({ offset: true });

/** Maximum length of one user message, enforced by the API and the UI. */
export const MAX_USER_MESSAGE_CHARS = 2000;

export const SendMessageRequestSchema = z.object({
  text: z.string().trim().min(1).max(MAX_USER_MESSAGE_CHARS),
});
export type SendMessageRequest = z.infer<typeof SendMessageRequestSchema>;

export const ConversationSummarySchema = z.object({
  id: uuid,
  title: z.string().nullable(),
  createdAt: timestamp,
  updatedAt: timestamp,
});
export type ConversationSummary = z.infer<typeof ConversationSummarySchema>;

export const CreateConversationResponseSchema = ConversationSummarySchema;
export type CreateConversationResponse = z.infer<typeof CreateConversationResponseSchema>;

export const ListConversationsResponseSchema = z.object({
  conversations: z.array(ConversationSummarySchema),
});
export type ListConversationsResponse = z.infer<typeof ListConversationsResponseSchema>;

/** What the UI needs to show a source next to an answer. */
export const SourceSummarySchema = z.object({
  kind: SourceKindSchema,
  id: z.string().min(1),
  title: z.string().min(1),
  /** Destination id the source belongs to, when relevant. */
  destinationId: z.string().nullable(),
  /** Short excerpt or human-readable value (e.g. "May: 23°C / 14°C, 4 rain days"). */
  snippet: z.string().nullable(),
  /** Public URL of the original document (e.g. the Wikivoyage revision), when there is one. */
  url: z.url().nullable(),
  /** Licence or attribution text required by the source (e.g. "CC BY-SA 4.0"), when known. */
  license: z.string().min(1).nullable().optional(),
});
export type SourceSummary = z.infer<typeof SourceSummarySchema>;

/** One tool call as shown in the transparency panel. */
export const ToolCallSummarySchema = z.object({
  callId: z.string().min(1),
  name: z.string().min(1),
  /** Arguments as sent by the model (validated JSON). */
  input: z.unknown(),
  ok: z.boolean(),
  durationMs: z.number().nonnegative(),
  /** One-line human summary of the result or the error. */
  summary: z.string(),
});
export type ToolCallSummary = z.infer<typeof ToolCallSummarySchema>;

export const UsageSchema = z.object({
  inputTokens: z.int().nonnegative(),
  outputTokens: z.int().nonnegative(),
  cacheReadTokens: z.int().nonnegative(),
  cacheWriteTokens: z.int().nonnegative(),
});
export type Usage = z.infer<typeof UsageSchema>;

/** Measured figures of one agent run. */
export const RunStatsSchema = z.object({
  steps: z.int().nonnegative(),
  usage: UsageSchema,
  costUsd: z.number().nonnegative(),
  latencyMs: z.number().nonnegative(),
  /** Langfuse trace id when tracing is enabled. */
  traceId: z.string().nullable(),
});
export type RunStats = z.infer<typeof RunStatsSchema>;

export const UserMessageSchema = z.object({
  id: uuid,
  role: z.literal('user'),
  text: z.string(),
  createdAt: timestamp,
});
export type UserMessage = z.infer<typeof UserMessageSchema>;

export const AssistantMessageSchema = z.object({
  id: uuid,
  role: z.literal('assistant'),
  runId: uuid,
  response: AgentResponseSchema,
  sources: z.array(SourceSummarySchema),
  toolCalls: z.array(ToolCallSummarySchema),
  createdAt: timestamp,
  /** Present when the conversation is loaded; absent in the live `response` event (see `run.finished`). */
  run: RunStatsSchema.optional(),
  /** The caller's rating of this run, when loaded and already given. */
  feedback: z
    .object({ rating: z.union([z.literal(1), z.literal(-1)]) })
    .nullable()
    .optional(),
});
export type AssistantMessage = z.infer<typeof AssistantMessageSchema>;

export const ConversationMessageSchema = z.discriminatedUnion('role', [
  UserMessageSchema,
  AssistantMessageSchema,
]);
export type ConversationMessage = z.infer<typeof ConversationMessageSchema>;

export const GetConversationResponseSchema = ConversationSummarySchema.extend({
  brief: TripBriefSchema,
  messages: z.array(ConversationMessageSchema),
});
export type GetConversationResponse = z.infer<typeof GetConversationResponseSchema>;

export const FeedbackRequestSchema = z.object({
  rating: z.union([z.literal(1), z.literal(-1)]),
  comment: z.string().trim().max(500).nullable(),
});
export type FeedbackRequest = z.infer<typeof FeedbackRequestSchema>;

// ---------------------------------------------------------------------------------------------
// Server-Sent Events of `POST /api/conversations/:id/messages` (event name = `type`).
// Step-level events, not token streaming: the final answer is validated JSON shown at once.
// ---------------------------------------------------------------------------------------------

export const RunStartedEventSchema = z.object({
  type: z.literal('run.started'),
  runId: uuid,
  conversationId: uuid,
  userMessageId: uuid,
});

export const ToolStartedEventSchema = z.object({
  type: z.literal('tool.started'),
  runId: uuid,
  callId: z.string().min(1),
  name: z.string().min(1),
  input: z.unknown(),
});

export const ToolFinishedEventSchema = z.object({
  type: z.literal('tool.finished'),
  runId: uuid,
  call: ToolCallSummarySchema,
});

export const ResponseEventSchema = z.object({
  type: z.literal('response'),
  runId: uuid,
  message: AssistantMessageSchema,
});

export const RunFinishedEventSchema = z.object({
  type: z.literal('run.finished'),
  runId: uuid,
  steps: z.int().nonnegative(),
  usage: UsageSchema,
  costUsd: z.number().nonnegative(),
  latencyMs: z.number().nonnegative(),
  /** Langfuse trace id when tracing is enabled. */
  traceId: z.string().nullable(),
});

export const ErrorEventSchema = z.object({
  type: z.literal('error'),
  runId: uuid.nullable(),
  error: z.object({ code: ApiErrorCodeSchema, message: z.string().min(1) }),
});

export const AgentEventSchema = z.discriminatedUnion('type', [
  RunStartedEventSchema,
  ToolStartedEventSchema,
  ToolFinishedEventSchema,
  ResponseEventSchema,
  RunFinishedEventSchema,
  ErrorEventSchema,
]);
export type AgentEvent = z.infer<typeof AgentEventSchema>;
export type AgentEventType = AgentEvent['type'];

export type RunStartedEvent = z.infer<typeof RunStartedEventSchema>;
export type ToolStartedEvent = z.infer<typeof ToolStartedEventSchema>;
export type ToolFinishedEvent = z.infer<typeof ToolFinishedEventSchema>;
export type ResponseEvent = z.infer<typeof ResponseEventSchema>;
export type RunFinishedEvent = z.infer<typeof RunFinishedEventSchema>;
export type ErrorEvent = z.infer<typeof ErrorEventSchema>;
