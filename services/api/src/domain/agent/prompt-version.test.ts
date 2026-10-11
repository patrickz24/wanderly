import { describe, expect, it } from 'vitest';
import { AGENT_TOOL_SPECS } from '../tools/registry.js';
import { agentPromptVersion, promptFingerprint, type PromptParts } from './prompt-version.js';
import { PROMPT_VERSION } from './system-prompt.js';

const TOOL = { name: 'search_knowledge', description: 'Search.', inputSchema: {}, strict: true };
const PARTS: PromptParts = {
  system: 'You are Wanderly.',
  tools: [TOOL],
  model: 'claude-haiku-5-5',
};

describe('promptFingerprint', () => {
  it('is 12 hex characters, the same for the same parts', () => {
    expect(promptFingerprint(PARTS)).toMatch(/^[0-9a-f]{12}$/);
    expect(promptFingerprint({ ...PARTS, tools: [...PARTS.tools] })).toBe(promptFingerprint(PARTS));
  });

  it.each<[string, Partial<PromptParts>]>([
    ['system prompt', { system: 'You are Wanderly!' }],
    ['tool description', { tools: [{ ...TOOL, description: 'Search the guides.' }] }],
    ['tool schema', { tools: [{ ...TOOL, inputSchema: { type: 'object' } }] }],
    ['tool list', { tools: [] }],
    ['model', { model: 'claude-sonnet-5-5' }],
  ])('changes when the %s changes', (_, change) => {
    expect(promptFingerprint({ ...PARTS, ...change })).not.toBe(promptFingerprint(PARTS));
  });
});

describe('agentPromptVersion', () => {
  it('prefixes the fingerprint with the hand-bumped prompt label', () => {
    expect(agentPromptVersion('claude-haiku-5-5')).toMatch(
      new RegExp(`^${PROMPT_VERSION}-[0-9a-f]{12}$`),
    );
  });

  it('is stable for a model and differs across models', () => {
    expect(agentPromptVersion('claude-haiku-5-5')).toBe(agentPromptVersion('claude-haiku-5-5'));
    expect(agentPromptVersion('claude-haiku-5-5')).not.toBe(
      agentPromptVersion('claude-sonnet-5-5'),
    );
  });

  it('covers the tool specs', () => {
    expect(agentPromptVersion('claude-haiku-5-5', AGENT_TOOL_SPECS.slice(1))).not.toBe(
      agentPromptVersion('claude-haiku-5-5'),
    );
  });
});
