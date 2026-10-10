import type { TripBrief } from '@wanderly/contracts';
import type { LlmMessage, ToolCallBlock, ToolResultBlock } from '../ports/llm.js';
import { isTerminalToolName } from '../tools/terminal-tools.js';
import { pendingToolCalls, textBlock, toolResult, userMessage } from './messages.js';

/**
 * Builds the user turn of a run. Its content, in order:
 *
 * 1. `tool_result` blocks answering the tool calls left open by the previous run. A successful
 *    run ends with the assistant message holding its terminal tool call (that message is the
 *    response); the provider requires every `tool_use` to be answered at the start of the next
 *    user message, so it is answered here, when the next turn starts. Calls of a run that failed
 *    are closed by that run itself (see `closePendingCalls`), so an open terminal call here was
 *    delivered.
 * 2. A context block written by the application: today's date and the trip brief so far. It is
 *    per-turn data, kept out of the system prompt so the prompt prefix stays cacheable.
 * 3. The user's own words, in their own block, never mixed with application text.
 */
export interface UserTurnInput {
  readonly history: readonly LlmMessage[];
  readonly userText: string;
  readonly brief: TripBrief;
  readonly today: string;
}

export const DELIVERED_RESULT = 'Delivered to the user.';
export const NOT_EXECUTED_RESULT = 'Not executed: the turn ended before this call ran.';

export function buildUserTurn(input: UserTurnInput): LlmMessage {
  return userMessage([
    ...answerOpenCalls(pendingToolCalls(input.history)),
    textBlock(contextBlock(input.today, input.brief)),
    textBlock(input.userText),
  ]);
}

function answerOpenCalls(calls: readonly ToolCallBlock[]): ToolResultBlock[] {
  return calls.map((call) =>
    isTerminalToolName(call.name)
      ? toolResult(call.id, DELIVERED_RESULT, false)
      : toolResult(call.id, NOT_EXECUTED_RESULT, true),
  );
}

export function contextBlock(today: string, brief: TripBrief): string {
  return [
    '<context>',
    'Written by the Wanderly application, not by the user.',
    `Today's date: ${today}`,
    `Trip brief so far: ${serializeBrief(brief)}`,
    '</context>',
  ].join('\n');
}

/** Fixed key order: the stored turn is replayed verbatim, and the text should not depend on how the brief was loaded. */
export function serializeBrief(brief: TripBrief): string {
  return JSON.stringify({
    destinationId: brief.destinationId,
    month: brief.month,
    startDate: brief.startDate,
    durationDays: brief.durationDays,
    travelers: brief.travelers,
    budgetLevel: brief.budgetLevel,
    interests: brief.interests,
    constraints: brief.constraints,
  });
}
