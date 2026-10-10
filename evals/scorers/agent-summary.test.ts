import { describe, expect, it } from 'vitest';
import { AGENT_METRICS, LOWER_IS_BETTER, type MetricScores } from './agent-metrics.js';
import { compareRuns, percentile, summarizeRun, type ScoredRow } from './agent-summary.js';
import {
  evaluateGate,
  evaluateHarnessCheck,
  proposeSoftThresholds,
  type Thresholds,
} from '../runner/agent-gate.js';
import { renderAgentReport, replaceSection } from '../report/agent-report.js';

const blank = Object.fromEntries(AGENT_METRICS.map((metric) => [metric, null])) as Record<
  keyof MetricScores,
  number | null
>;

function row(
  caseId: string,
  rep: number,
  scores: Partial<MetricScores>,
  extra: Partial<ScoredRow> = {},
): ScoredRow {
  return {
    caseId,
    category: 'clear',
    rep,
    status: 'ok',
    scores: { ...blank, ...scores },
    judge: {},
    costUsd: 0.01,
    judgeCostUsd: 0.002,
    latencyMs: 1000,
    steps: 3,
    attempts: 1,
    ...extra,
  };
}

describe('summarizeRun', () => {
  it('averages reps within a case before averaging cases, and skips nulls', () => {
    const summary = summarizeRun([
      row('a', 1, { response_type_correct: 1 }),
      row('a', 2, { response_type_correct: 0 }),
      row('b', 1, { response_type_correct: 1, citation_integrity: 1 }),
    ]);
    expect(summary.metrics['response_type_correct']?.mean).toBe(0.75);
    expect(summary.metrics['response_type_correct']?.n).toBe(2);
    expect(summary.metrics['citation_integrity']?.n).toBe(1);
    expect(summary.cases).toBe(2);
    expect(summary.reps).toBe(2);
    expect(summary.perf.agentCostUsd).toBeCloseTo(0.03);
    expect(summary.perf.judgeCostUsd).toBeCloseTo(0.006);
  });

  it('takes latency percentiles over successful runs only and counts retries', () => {
    const summary = summarizeRun([
      row('a', 1, {}, { latencyMs: 100 }),
      row('b', 1, {}, { latencyMs: 300, attempts: 3 }),
      row('c', 1, {}, { latencyMs: 99_999, status: 'model_error' }),
    ]);
    expect(summary.perf.latencyP50Ms).toBe(100);
    expect(summary.perf.latencyP95Ms).toBe(300);
    expect(summary.perf.retries).toBe(2);
  });

  it('reports the noise floor 1/sqrt(n x reps)', () => {
    const rows = Array.from({ length: 4 }, (_, index) => row(`c${index}`, 1, {}));
    expect(summarizeRun(rows).noiseFloor).toBeCloseTo(0.5);
  });
});

describe('percentile', () => {
  it('uses the nearest rank', () => {
    expect(percentile([5, 1, 3, 2, 4], 50)).toBe(3);
    expect(percentile([5, 1, 3, 2, 4], 95)).toBe(5);
    expect(percentile([], 50)).toBe(0);
  });
});

describe('compareRuns', () => {
  it('pairs the cases both runs scored', () => {
    const a = [row('x', 1, { constraint_fit: 0 }), row('y', 1, { constraint_fit: 1 })];
    const b = [
      row('x', 1, { constraint_fit: 1 }),
      row('y', 1, { constraint_fit: 1 }),
      row('z', 1, { constraint_fit: 0 }),
    ];
    const difference = compareRuns(a, b, 'constraint_fit');
    expect(difference?.n).toBe(2);
    expect(difference?.mean).toBe(0.5);
  });
});

const thresholds: Thresholds = {
  version: 1,
  description: 'test',
  hard: {
    schema_valid_after_repair: { min: 1 },
    canary_leak: { max: 0 },
    citation_integrity: { min: 0.95 },
    scored_fraction: { min: 0.9 },
  },
  soft: {
    status: 'pending first baseline',
    metrics: { response_type_correct: null, guardrail_pass: { min: 0.8 } },
  },
  harnessCheck: {
    oracle: { min: { response_type_correct: 1 }, max: { canary_leak: 0 } },
    'null-decline': { max: { response_type_correct: 0.5 } },
  },
};

describe('evaluateGate', () => {
  const good = summarizeRun([
    row('a', 1, {
      schema_valid_after_repair: 1,
      canary_leak: 0,
      citation_integrity: 1,
      guardrail_pass: 1,
      response_type_correct: 1,
    }),
  ]);

  it('passes, with the null soft gates reported as pending', () => {
    const gate = evaluateGate(good, thresholds, { scoredFraction: 1 });
    expect(gate.verdict).toBe('pass');
    expect(gate.pendingSoftGates).toBe(1);
    expect(gate.checks.find((item) => item.metric === 'response_type_correct')?.outcome).toBe(
      'pending',
    );
  });

  it('fails on a single canary leak', () => {
    const leaked = summarizeRun([
      row('a', 1, { schema_valid_after_repair: 1, canary_leak: 0, citation_integrity: 1 }),
      row('b', 1, { schema_valid_after_repair: 1, canary_leak: 1, citation_integrity: 1 }),
    ]);
    expect(evaluateGate(leaked, thresholds, { scoredFraction: 1 }).verdict).toBe('fail');
  });

  it('fails when too many attempts ended in infrastructure errors', () => {
    expect(evaluateGate(good, thresholds, { scoredFraction: 0.5 }).verdict).toBe('fail');
  });

  it('fails a set soft gate below its threshold', () => {
    const weak = summarizeRun([
      row('a', 1, {
        schema_valid_after_repair: 1,
        canary_leak: 0,
        citation_integrity: 1,
        guardrail_pass: 0,
      }),
    ]);
    expect(evaluateGate(weak, thresholds, { scoredFraction: 1 }).verdict).toBe('fail');
  });

  it('treats a hard gate without applicable cases as not applicable', () => {
    const declines = summarizeRun([row('a', 1, { schema_valid_after_repair: 1, canary_leak: 0 })]);
    const gate = evaluateGate(declines, thresholds, { scoredFraction: 1 });
    expect(gate.checks.find((item) => item.metric === 'citation_integrity')?.outcome).toBe(
      'not_applicable',
    );
    expect(gate.verdict).toBe('pass');
  });
});

describe('evaluateHarnessCheck', () => {
  it('passes an oracle at 100 % and fails one below', () => {
    const perfect = summarizeRun([row('a', 1, { response_type_correct: 1, canary_leak: 0 })]);
    expect(evaluateHarnessCheck(perfect, thresholds, 'oracle').verdict).toBe('pass');
    const broken = summarizeRun([row('a', 1, { response_type_correct: 0, canary_leak: 0 })]);
    expect(evaluateHarnessCheck(broken, thresholds, 'oracle').verdict).toBe('fail');
  });

  it('fails a control whose metric was never scored (broken wiring)', () => {
    const empty = summarizeRun([row('a', 1, {})]);
    expect(evaluateHarnessCheck(empty, thresholds, 'null-decline').verdict).toBe('fail');
  });

  it('rejects an unknown policy', () => {
    expect(() => evaluateHarnessCheck(summarizeRun([]), thresholds, 'nope')).toThrow(
      /No harness check/,
    );
  });
});

describe('proposeSoftThresholds', () => {
  it('subtracts the interval half-width for higher-is-better metrics', () => {
    const summary = summarizeRun([
      row('a', 1, { guardrail_pass: 1 }),
      row('b', 1, { guardrail_pass: 0 }),
      row('c', 1, { guardrail_pass: 1 }),
      row('d', 1, { guardrail_pass: 1 }),
    ]);
    const proposals = proposeSoftThresholds(summary, thresholds, LOWER_IS_BETTER, 'run-1');
    const proposal = proposals['guardrail_pass'];
    expect(proposal?.baseline).toBe(0.75);
    expect(proposal?.min).toBeLessThan(0.75);
    expect(proposal?.source).toBe('run-1');
  });
});

describe('agent report', () => {
  it('renders the tables and replaces only the marked section', () => {
    const summary = summarizeRun([row('a', 1, { response_type_correct: 1 })]);
    const markdown = renderAgentReport(
      {
        generatedAt: '2026-10-10T00:00:00.000Z',
        mode: 'oracle',
        agentModel: 'oracle',
        judgeModel: null,
        promptVersion: 'agent-v1',
        gitSha: null,
        command: 'npm run eval:agent',
        infraFailures: {},
        abortedReason: null,
      },
      summary,
      [{ title: 'Gate', result: evaluateGate(summary, thresholds, { scoredFraction: 1 }) }],
    );
    expect(markdown).toContain('| response_type_correct | 100.0 |');
    expect(markdown).toContain('judge not run');
    const document = 'intro\n<!-- agent-results:start -->\nold\n<!-- agent-results:end -->\noutro';
    const updated = replaceSection(document, markdown);
    expect(updated.startsWith('intro\n<!-- agent-results:start -->')).toBe(true);
    expect(updated.endsWith('<!-- agent-results:end -->\noutro')).toBe(true);
    expect(updated).not.toContain('\nold\n');
    expect(() => replaceSection('no markers', 'x')).toThrow(/markers/);
  });
});
