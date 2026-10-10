import { describe, expect, it } from 'vitest';
import { DEFAULT_AGENT_LIMITS } from '../domain/agent/limits.js';
import { ProviderUnavailableError } from '../domain/errors.js';
import { AnthropicLlm } from '../infrastructure/llm/anthropic-llm.js';
import { agentLimits, createAgentLlm } from './agent-deps.js';

const warn = () => undefined;
const settings = { model: 'claude-haiku-5-5', effort: 'medium' as const, timeoutMs: 45_000 };

describe('createAgentLlm', () => {
  it('fails every call as provider unavailable without an API key, without network access', async () => {
    const llm = createAgentLlm({ ...settings, apiKey: undefined }, warn);
    expect(llm.model).toBe('claude-haiku-5-5');
    await expect(
      llm.generate(
        { system: 's', tools: [], messages: [], maxTokens: 10 },
        { signal: new AbortController().signal },
      ),
    ).rejects.toBeInstanceOf(ProviderUnavailableError);
  });

  it('builds the Anthropic adapter for the configured model with a key', () => {
    const llm = createAgentLlm({ ...settings, apiKey: 'sk-test' }, warn);
    expect(llm).toBeInstanceOf(AnthropicLlm);
    expect(llm.model).toBe('claude-haiku-5-5');
  });
});

describe('agentLimits', () => {
  const base = { llmTimeoutMs: 1_000, runDeadlineMs: 2_000, maxSteps: 4 };

  it('overrides the deadlines and steps and keeps the default cost ceiling', () => {
    expect(agentLimits({ ...base, maxRunCostUsd: undefined })).toEqual({
      ...DEFAULT_AGENT_LIMITS,
      llmTimeoutMs: 1_000,
      runDeadlineMs: 2_000,
      maxSteps: 4,
    });
  });

  it('applies a configured cost ceiling', () => {
    expect(agentLimits({ ...base, maxRunCostUsd: 0.5 }).maxRunCostUsd).toBe(0.5);
  });
});
