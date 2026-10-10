import {
  AgentResponseSchema,
  EMPTY_TRIP_BRIEF,
  SourceSummarySchema,
  ToolCallSummarySchema,
  TripBriefSchema,
  type TripBrief,
} from '@wanderly/contracts';
import { z } from 'zod';
import type { LlmMessage } from '../../domain/ports/llm.js';

/**
 * Validation of JSON read back from Postgres. Stored values were valid when written; a mismatch
 * means a bug or a missing data migration, so reading fails loudly instead of guessing.
 *
 * Message blocks are loose objects: provider blocks are replayed verbatim, so unknown keys must
 * survive a round trip.
 */

const TextBlockSchema = z.looseObject({ type: z.literal('text'), text: z.string() });
const ToolCallBlockSchema = z.looseObject({
  type: z.literal('tool_call'),
  id: z.string().min(1),
  name: z.string().min(1),
  input: z.json(),
});
const OpaqueBlockSchema = z.looseObject({
  type: z.literal('opaque'),
  provider: z.string().min(1),
  data: z.json(),
});
const ToolResultBlockSchema = z.looseObject({
  type: z.literal('tool_result'),
  toolCallId: z.string().min(1),
  content: z.string(),
  isError: z.boolean(),
});

const UserContentSchema = z.array(
  z.discriminatedUnion('type', [TextBlockSchema, ToolResultBlockSchema]),
);
const AssistantContentSchema = z.array(
  z.discriminatedUnion('type', [TextBlockSchema, ToolCallBlockSchema, OpaqueBlockSchema]),
);

/** Stored role: user messages made only of tool results are stored as `tool`. */
export type StoredRole = 'user' | 'assistant' | 'tool';

export function storedRole(message: LlmMessage): StoredRole {
  if (message.role === 'assistant') return 'assistant';
  const toolResultsOnly =
    message.content.length > 0 && message.content.every((block) => block.type === 'tool_result');
  return toolResultsOnly ? 'tool' : 'user';
}

export function parseStoredMessage(role: string, content: unknown): LlmMessage {
  switch (role) {
    case 'assistant':
      return { role: 'assistant', content: AssistantContentSchema.parse(content) };
    case 'user':
    case 'tool':
      return { role: 'user', content: UserContentSchema.parse(content) };
    default:
      throw new Error(`Unknown stored message role: ${role}`);
  }
}

/** The column default `{}` predates any turn: it means an empty brief. */
export function parseStoredBrief(value: unknown): TripBrief {
  if (typeof value === 'object' && value !== null && Object.keys(value).length === 0) {
    return EMPTY_TRIP_BRIEF;
  }
  return TripBriefSchema.parse(value);
}

export const StoredDisplaySchema = z.object({
  response: AgentResponseSchema,
  sources: z.array(SourceSummarySchema),
  toolCalls: z.array(ToolCallSummarySchema),
});
