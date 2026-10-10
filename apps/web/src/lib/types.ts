import type { AgentResponse, AgentResponseType } from '@wanderly/contracts';

/** One variant of the agent's response union, e.g. `AgentResponseOf<'itinerary'>`. */
export type AgentResponseOf<T extends AgentResponseType> = Extract<AgentResponse, { type: T }>;
