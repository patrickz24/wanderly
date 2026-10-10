import { readFile } from 'node:fs/promises';
import { EMPTY_TRIP_BRIEF } from '@wanderly/contracts';
import { describe, expect, it } from 'vitest';
import { parse } from 'yaml';
import {
  CalibrationSetSchema,
  computeCalibration,
  renderCalibration,
  type CalibrationItem,
} from './calibration.js';

function item(
  id: string,
  judge: CalibrationItem['judge'],
  human: CalibrationItem['human'],
): CalibrationItem {
  return {
    id,
    caseId: id,
    rep: 1,
    source: 'run',
    judgeModel: 'claude-sonnet-5-5',
    judgePromptVersion: 'judge-v1',
    userTurns: ['Plan a trip'],
    response: { type: 'answer', message: 'x', sourceRefs: [], brief: EMPTY_TRIP_BRIEF },
    retrievedContext: [],
    judge,
    human,
    notes: '',
  };
}

describe('judge calibration', () => {
  it('ships an empty, valid calibration set', async () => {
    const text = await readFile(
      new URL('../datasets/judge-calibration.yaml', import.meta.url),
      'utf8',
    );
    expect(CalibrationSetSchema.parse(parse(text)).items).toEqual([]);
  });

  it('says plainly that the judge is not calibrated before any human label', () => {
    const report = computeCalibration([
      item('a', { faithful: 1, request_fit: 2 }, { faithful: null, request_fit: null }),
    ]);
    expect(report.labelled).toBe(0);
    expect(renderCalibration(report)).toMatch(/No human labels yet/);
  });

  it('computes agreement and kappa per property over items both graded', () => {
    const report = computeCalibration([
      item('a', { faithful: 1, request_fit: 2 }, { faithful: true, request_fit: 2 }),
      item('b', { faithful: 0, request_fit: 1 }, { faithful: false, request_fit: 0 }),
      item('c', { faithful: 1, request_fit: 0 }, { faithful: false, request_fit: 0 }),
      item('d', { faithful: 0, request_fit: null }, { faithful: false, request_fit: 1 }),
    ]);
    expect(report.labelled).toBe(4);
    expect(report.faithful.n).toBe(4);
    expect(report.faithful.agreement).toBe(0.75);
    expect(report.requestFit.n).toBe(3);
    expect(report.requestFit.agreement).toBeCloseTo(2 / 3);
    expect(renderCalibration(report)).toContain('| faithful (all claims supported) | 4 | 75.0 % |');
  });
});
