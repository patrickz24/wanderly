import { describe, expect, it } from 'vitest';
import { testConfig } from '../../test/support.js';
import { DEFAULT_AGENT_LIMITS } from '../domain/agent/limits.js';
import type { AgentRunResult } from '../domain/agent/types.js';
import { InvalidOutputError } from '../domain/errors.js';
import { agentLimits, formatEvent, formatResult, parseChatArgs } from './chat.js';

const common = {
  newMessages: [],
  toolCalls: [],
  usage: { inputTokens: 10, outputTokens: 5, cacheReadTokens: 2, cacheWriteTokens: 1 },
  costUsd: 0.000123,
  steps: 2,
  repairs: 0,
  latencyMs: 1500,
  signals: { canaryLeak: false, providerRefusal: false, injectionSignals: [] },
};

describe('parseChatArgs', () => {
  it('joins the positional words into the message and defaults the brief', () => {
    const options = parseChatArgs(['Plan', '3 days', 'in Sicily']);
    expect(options.text).toBe('Plan 3 days in Sicily');
    expect(options.brief.destinationId).toBeNull();
    expect(options.json).toBe(false);
  });

  it('validates a brief given as JSON', () => {
    const brief = JSON.stringify({
      ...parseChatArgs(['x']).brief,
      destinationId: 'sicily',
      month: 5,
    });
    expect(parseChatArgs(['--brief', brief, '--json', 'More beaches']).brief).toMatchObject({
      destinationId: 'sicily',
      month: 5,
    });
    expect(() => parseChatArgs(['--brief', '{"month":13}', 'x'])).toThrow();
  });

  it('requires a message and rejects unknown options', () => {
    expect(() => parseChatArgs([])).toThrow(/Usage/);
    expect(() => parseChatArgs(['--verbose', 'x'])).toThrow();
  });
});

describe('agentLimits', () => {
  it('takes the configured limits and keeps the runtime defaults for the rest', () => {
    const config = testConfig({
      AGENT_MAX_STEPS: '5',
      LLM_TIMEOUT_MS: '20000',
      AGENT_RUN_DEADLINE_MS: '60000',
    });
    expect(agentLimits(config)).toEqual({
      ...DEFAULT_AGENT_LIMITS,
      maxSteps: 5,
      llmTimeoutMs: 20_000,
      runDeadlineMs: 60_000,
    });
    expect(agentLimits(testConfig({ AGENT_MAX_RUN_COST_USD: '0.5' })).maxRunCostUsd).toBe(0.5);
  });
});

describe('formatting', () => {
  it('prints tool events on one line', () => {
    expect(
      formatEvent({ type: 'tool.started', callId: 'c', name: 'search_pois', input: { a: 1 } }),
    ).toBe('→ search_pois {"a":1}');
    expect(
      formatEvent({
        type: 'tool.finished',
        call: {
          callId: 'c',
          name: 'search_pois',
          input: {},
          ok: false,
          durationMs: 12,
          summary: 'timed out',
        },
      }),
    ).toBe('✗ search_pois (12 ms): timed out');
  });

  it('prints a response with its sources and cost', () => {
    const result: AgentRunResult = {
      ...common,
      status: 'ok',
      response: {
        type: 'clarification',
        message: 'Which month?',
        questions: ['Which month?'],
        brief: parseChatArgs(['x']).brief,
      },
      sources: [],
      validFirstTry: false,
    };
    const text = formatResult(result);
    expect(text).toContain('CLARIFICATION (after repair)');
    expect(text).toContain('sources: none');
    expect(text).toContain('cost 0.000123 USD, 1500 ms');
  });

  it('prints an error with its reason', () => {
    const result: AgentRunResult = {
      ...common,
      status: 'error',
      error: new InvalidOutputError(['x']),
      reason: 'step_limit',
    };
    expect(formatResult(result)).toMatch(/^ERROR INVALID_OUTPUT \(step_limit\): /);
  });
});
