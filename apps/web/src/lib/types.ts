import type {
  AgentEvent,
  AgentEventType,
  AgentResponse,
  AgentResponseType,
  ConversationMessage,
} from '@wanderly/contracts';

/** Named views of the contract's unions, for readability in the web client. */
export type AssistantMessage = Extract<ConversationMessage, { role: 'assistant' }>;
export type UserMessage = Extract<ConversationMessage, { role: 'user' }>;
export type AgentEventOf<T extends AgentEventType> = Extract<AgentEvent, { type: T }>;
export type AgentResponseOf<T extends AgentResponseType> = Extract<AgentResponse, { type: T }>;
export type RunFinishedEvent = AgentEventOf<'run.finished'>;

/** What the run footer shows: the `run.finished` event without its envelope. */
export type RunStats = Omit<RunFinishedEvent, 'type' | 'runId'>;
