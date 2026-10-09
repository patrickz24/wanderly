export type CheckStatus = 'pass' | 'fail';

/**
 * Outcome of one dependency check.
 * `output` is short and safe to show publicly; `detail` is internal diagnostic
 * data (errors, pending migration names…) that is logged but never returned.
 */
export type CheckOutcome =
  | { readonly status: 'pass' }
  | { readonly status: 'fail'; readonly output: string; readonly detail?: unknown };

/** One named dependency check (database, migrations, embedder…), implemented by adapters. */
export interface ReadinessCheck {
  readonly name: string;
  run(signal: AbortSignal): Promise<CheckOutcome>;
}

export interface CheckResult {
  readonly status: CheckStatus;
  readonly durationMs: number;
  readonly output?: string;
  readonly detail?: unknown;
}

export interface ReadinessReport {
  readonly status: CheckStatus;
  readonly checks: Readonly<Record<string, CheckResult>>;
}

/** Port used by `GET /ready`: is this instance able to serve traffic? */
export interface ReadinessProbe {
  check(): Promise<ReadinessReport>;
}
