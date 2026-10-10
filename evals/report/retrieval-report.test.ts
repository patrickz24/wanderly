import { describe, expect, it } from 'vitest';
import {
  RESULTS_END,
  RESULTS_START,
  median,
  renderTable,
  replaceBetweenMarkers,
} from './retrieval-report.js';

describe('renderTable', () => {
  it('renders one row per configuration with percentages and intervals', () => {
    const table = renderTable([
      {
        chunking: 'structure',
        strategy: 'hybrid (any word)',
        chunks: 2136,
        metrics: { recallAt5: 0.8, recallAt10: 0.9, mrrAt10: 0.654, hitAt1: 0.5, hitAt5: 0.85 },
        intervals: { mrrAt10: { low: 0.55, high: 0.75 }, recallAt5: { low: 0.7, high: 0.9 } },
        medianLatencyMs: 23.4,
      },
    ]);

    expect(table.split('\n')).toEqual([
      '| Chunking | Strategy | Chunks | Recall@5 | Recall@10 | MRR@10 | Hit@1 | Hit@5 | p50 latency |',
      '|---|---|---:|---:|---:|---:|---:|---:|---:|',
      '| structure | hybrid (any word) | 2136 | 80.0 (70.0–90.0) | 90.0 | 65.4 (55.0–75.0) | 50.0 | 85.0 | 23 ms |',
    ]);
  });
});

describe('replaceBetweenMarkers', () => {
  it('replaces only the generated section', () => {
    const doc = `# Title\n\nIntro.\n\n${RESULTS_START}\nold\n${RESULTS_END}\n\nAfter.\n`;

    expect(replaceBetweenMarkers(doc, 'new table')).toBe(
      `# Title\n\nIntro.\n\n${RESULTS_START}\n\nnew table\n\n${RESULTS_END}\n\nAfter.\n`,
    );
  });

  it('fails when the markers are missing', () => {
    expect(() => replaceBetweenMarkers('# Title', 'x')).toThrow('not found');
  });
});

describe('median', () => {
  it('handles odd, even and empty inputs', () => {
    expect(median([3, 1, 2])).toBe(2);
    expect(median([4, 1, 2, 3])).toBe(2.5);
    expect(median([])).toBe(0);
  });
});
