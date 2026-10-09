import { loadConfig, type Config } from '../src/config.js';
import type { LogDestination } from '../src/api/logger.js';
import type { ReadinessProbe, ReadinessReport } from '../src/application/ports/readiness.js';

export const TEST_SESSION_SECRET = 'test-session-secret-0123456789abcdef';
export const TEST_DATABASE_URL = 'postgres://wanderly:wanderly@localhost:5432/wanderly';

/** A validated config for tests: same code path as production, explicit overrides. */
export function testConfig(overrides: Record<string, string> = {}): Config {
  return loadConfig({
    NODE_ENV: 'test',
    LOG_LEVEL: 'silent',
    DATABASE_URL: TEST_DATABASE_URL,
    SESSION_SECRET: TEST_SESSION_SECRET,
    ...overrides,
  });
}

export const PASSING_REPORT: ReadinessReport = {
  status: 'pass',
  checks: { database: { status: 'pass', durationMs: 1 } },
};

export function fakeProbe(report: ReadinessReport = PASSING_REPORT): ReadinessProbe {
  return { check: async () => report };
}

export interface MemoryLog extends LogDestination {
  readonly lines: string[];
  entries(): Array<Record<string, unknown>>;
}

/** Captures pino's JSON lines so tests can assert on what is (not) logged. */
export function memoryLog(): MemoryLog {
  const lines: string[] = [];
  return {
    lines,
    write(line: string) {
      lines.push(line);
    },
    entries() {
      return lines.map((line) => JSON.parse(line) as Record<string, unknown>);
    },
  };
}
