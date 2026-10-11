import { EMPTY_TRIP_BRIEF } from '@wanderly/contracts';
import { describe, expect, it } from 'vitest';
import { errorResult, okResult } from '../../test/agent-fakes.js';
import { ANSWER, recordingTracer } from '../../test/application-fakes.js';
import type { AgentRunInput } from '../domain/agent/types.js';
import { InvalidOutputError, LlmTimeoutError } from '../domain/errors.js';
import { ZERO_USAGE } from '../domain/ports/llm.js';
import {
  TRACE_SCORES,
  closeRunTrace,
  traceSummaryOf,
  validFirstTryOf,
  type RunTraceSummary,
} from './run-trace.js';

const INPUT: AgentRunInput = {
  runId: 'run-1',
  conversationId: 'conversation-1',
  history: [],
  userText: 'Sicily in May?',
  brief: EMPTY_TRIP_BRIEF,
  today: '2026-10-11',
};

function startTrace() {
  const tracer = recordingTracer();
  const trace = tracer.startRun({
    runId: 'run-1',
    conversationId: 'conversation-1',
    model: 'fake-model',
    promptVersion: 'agent-v1-test',
    userText: 'Sicily in May?',
    tags: [],
  });
  const recorded = () => {
    const [first] = tracer.traces;
    if (first === undefined) throw new Error('no trace recorded');
    return first;
  };
  return { trace, recorded };
}

const scoreMap = (scores: ReadonlyArray<{ name: string; value: number }>) =>
  Object.fromEntries(scores.map((score) => [score.name, score.value]));

describe('validFirstTryOf', () => {
  it('is known for a delivered response, false for an invalid output, unknown otherwise', () => {
    expect(validFirstTryOf(okResult(INPUT, { validFirstTry: false }))).toBe(false);
    expect(validFirstTryOf(okResult(INPUT))).toBe(true);
    expect(
      validFirstTryOf(errorResult(INPUT, new InvalidOutputError(['bad']), 'invalid_output')),
    ).toBe(false);
    expect(validFirstTryOf(errorResult(INPUT, new LlmTimeoutError(45_000), 'llm_timeout'))).toBe(
      null,
    );
  });
});

describe('traceSummaryOf and closeRunTrace', () => {
  it('scores a delivered response and ends the trace with it', () => {
    const { trace, recorded } = startTrace();

    closeRunTrace(
      trace,
      traceSummaryOf(
        okResult(INPUT, {
          repairs: 1,
          validFirstTry: false,
          signals: { canaryLeak: false, providerRefusal: false, injectionSignals: ['user:x'] },
        }),
      ),
    );

    expect(scoreMap(recorded().scores)).toEqual({
      [TRACE_SCORES.validFirstTry]: 0,
      [TRACE_SCORES.citationsOk]: 1,
      [TRACE_SCORES.toolErrors]: 1,
      [TRACE_SCORES.repairs]: 1,
      [TRACE_SCORES.canaryLeak]: 0,
      [TRACE_SCORES.providerRefusal]: 0,
      [TRACE_SCORES.injectionSignals]: 1,
    });
    expect(
      recorded().scores.find((score) => score.name === TRACE_SCORES.injectionSignals)?.comment,
    ).toBe('user:x');
    expect(recorded().end).toEqual({
      status: 'ok',
      responseType: 'answer',
      errorCode: null,
      output: ANSWER,
      usage: { inputTokens: 3_000, outputTokens: 600, cacheReadTokens: 1_500, cacheWriteTokens: 0 },
      costUsd: 0.000615,
      steps: 2,
    });
  });

  it('scores a failed run without citations, with its error code and reason as output', () => {
    const { trace, recorded } = startTrace();

    closeRunTrace(
      trace,
      traceSummaryOf(errorResult(INPUT, new LlmTimeoutError(45_000), 'run_deadline')),
    );

    expect(recorded().scores.map((score) => score.name)).toEqual([
      TRACE_SCORES.toolErrors,
      TRACE_SCORES.repairs,
      TRACE_SCORES.canaryLeak,
      TRACE_SCORES.providerRefusal,
      TRACE_SCORES.injectionSignals,
    ]);
    expect(recorded().end).toMatchObject({
      status: 'error',
      responseType: null,
      errorCode: 'LLM_TIMEOUT',
      output: { error: 'LLM_TIMEOUT', reason: 'run_deadline' },
    });
  });

  it('leaves out the runtime scores when the runtime reported nothing', () => {
    const { trace, recorded } = startTrace();
    const crashed: RunTraceSummary = {
      status: 'error',
      responseType: null,
      errorCode: 'INTERNAL_ERROR',
      output: null,
      usage: ZERO_USAGE,
      costUsd: 0,
      steps: 0,
      validFirstTry: null,
      citationsOk: null,
      toolErrorCount: 0,
      runtime: null,
    };

    closeRunTrace(trace, crashed);

    expect(recorded().scores).toEqual([
      { name: TRACE_SCORES.toolErrors, value: 0, comment: undefined },
    ]);
    expect(recorded().end).toMatchObject({ status: 'error', errorCode: 'INTERNAL_ERROR' });
  });
});
