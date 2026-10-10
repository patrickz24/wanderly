import type { AgentRunDeps, AgentRunInput, AgentRunResult } from '../../domain/agent/types.js';

/**
 * The agent runtime (`runAgent` in the domain), injected so that use case tests drive it with a
 * scripted fake instead of a model.
 */
export type RunAgent = (input: AgentRunInput, deps: AgentRunDeps) => Promise<AgentRunResult>;
