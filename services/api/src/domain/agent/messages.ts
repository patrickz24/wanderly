import type {
  AssistantBlock,
  LlmMessage,
  TextBlock,
  ToolCallBlock,
  ToolResultBlock,
  UserBlock,
} from '../ports/llm.js';

/**
 * Message helpers. Messages are frozen when created: the history is append-only (the provider
 * rejects a conversation whose earlier turns changed), so nothing may edit a message in place.
 */

export function userMessage(blocks: readonly UserBlock[]): LlmMessage {
  return Object.freeze({ role: 'user', content: Object.freeze(blocks.map(freezeBlock)) });
}

export function assistantMessage(blocks: readonly AssistantBlock[]): LlmMessage {
  return Object.freeze({ role: 'assistant', content: Object.freeze(blocks.map(freezeBlock)) });
}

export function textBlock(text: string): TextBlock {
  return { type: 'text', text };
}

export function toolResult(toolCallId: string, content: string, isError: boolean): ToolResultBlock {
  return { type: 'tool_result', toolCallId, content, isError };
}

export function toolCallsOf(message: LlmMessage): ToolCallBlock[] {
  if (message.role !== 'assistant') return [];
  return message.content.filter((block): block is ToolCallBlock => block.type === 'tool_call');
}

/** Tool calls of the last message when it is an assistant message: they still need a result. */
export function pendingToolCalls(messages: readonly LlmMessage[]): ToolCallBlock[] {
  const last = messages.at(-1);
  return last === undefined ? [] : toolCallsOf(last);
}

export function visibleText(blocks: readonly AssistantBlock[]): string {
  return blocks
    .filter((block): block is TextBlock => block.type === 'text')
    .map((block) => block.text)
    .join('\n')
    .trim();
}

/** Deep freeze: tool inputs and opaque provider payloads are replayed verbatim as well. */
function freezeBlock<T extends UserBlock | AssistantBlock>(block: T): T {
  return deepFreeze({ ...block });
}

function deepFreeze<T>(value: T): T {
  if (typeof value === 'object' && value !== null && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const nested of Object.values(value)) deepFreeze(nested);
  }
  return value;
}
