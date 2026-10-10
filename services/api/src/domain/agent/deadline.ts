/**
 * Deadlines for LLM calls, tool executions and the whole run.
 *
 * The SDK has its own timeout, but it retries timed-out requests, so a call could last several
 * times its timeout; and the knowledge ports take no AbortSignal at all. `withDeadline` therefore
 * races the task against its own timer and against the run's signal: it settles at the deadline
 * even if the task ignores its signal (the late result is discarded).
 */

export type DeadlineScope = 'call' | 'run';

export class DeadlineExceeded extends Error {
  constructor(
    readonly scope: DeadlineScope,
    readonly timeoutMs: number,
  ) {
    super(`${scope === 'run' ? 'Run' : 'Call'} deadline of ${timeoutMs} ms exceeded`);
    this.name = 'DeadlineExceeded';
  }
}

/**
 * Runs `task` with a signal aborted after `timeoutMs` or when `parent` aborts. Rejects with a
 * `DeadlineExceeded('call')` on timeout, or with the parent's abort reason.
 */
export function withDeadline<T>(
  task: (signal: AbortSignal) => Promise<T>,
  timeoutMs: number,
  parent: AbortSignal,
): Promise<T> {
  if (parent.aborted) return Promise.reject(toError(parent.reason));
  const controller = new AbortController();
  return new Promise<T>((resolve, reject) => {
    // Declared before use at call time only: the timer and the listener exist by then.
    const cleanup = () => {
      clearTimeout(timer);
      parent.removeEventListener('abort', onParentAbort);
    };
    const abort = (reason: Error) => {
      cleanup();
      controller.abort(reason);
      reject(reason);
    };
    const onParentAbort = () => abort(toError(parent.reason));
    const timer = setTimeout(() => abort(new DeadlineExceeded('call', timeoutMs)), timeoutMs);
    parent.addEventListener('abort', onParentAbort, { once: true });
    let promise: Promise<T>;
    try {
      promise = task(controller.signal);
    } catch (error) {
      cleanup();
      reject(toError(error));
      return;
    }
    promise.then(
      (value) => {
        cleanup();
        resolve(value);
      },
      (error: unknown) => {
        cleanup();
        reject(toError(error));
      },
    );
  });
}

export interface RunDeadline {
  /** Aborted at the run deadline (reason: `DeadlineExceeded('run')`) or on cancellation. */
  readonly signal: AbortSignal;
  dispose(): void;
}

/** Starts the run's deadline timer, linked to the caller's cancellation signal if any. */
export function startRunDeadline(timeoutMs: number, cancel: AbortSignal | undefined): RunDeadline {
  const controller = new AbortController();
  const timer = setTimeout(
    () => controller.abort(new DeadlineExceeded('run', timeoutMs)),
    timeoutMs,
  );
  const onCancel = () => controller.abort(cancel?.reason);
  if (cancel?.aborted === true) onCancel();
  else cancel?.addEventListener('abort', onCancel, { once: true });
  return {
    signal: controller.signal,
    dispose() {
      clearTimeout(timer);
      cancel?.removeEventListener('abort', onCancel);
    },
  };
}

function toError(reason: unknown): Error {
  return reason instanceof Error ? reason : new Error(String(reason));
}
