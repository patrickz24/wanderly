import { describe, expect, it } from 'vitest';
import { DeadlineExceeded, startRunDeadline, withDeadline } from './deadline.js';

const never = () => new Promise<never>(() => undefined);

describe('withDeadline', () => {
  it('resolves with the task result', async () => {
    await expect(withDeadline(async () => 42, 100, new AbortController().signal)).resolves.toBe(42);
  });

  it('rejects at the deadline even if the task ignores its signal, and aborts the signal', async () => {
    let seen: AbortSignal | undefined;
    const pending = withDeadline(
      (signal) => {
        seen = signal;
        return never();
      },
      10,
      new AbortController().signal,
    );
    await expect(pending).rejects.toEqual(new DeadlineExceeded('call', 10));
    expect(seen?.aborted).toBe(true);
  });

  it('rejects with the parent reason when the parent aborts', async () => {
    const parent = new AbortController();
    const pending = withDeadline(never, 1_000, parent.signal);
    parent.abort(new DeadlineExceeded('run', 50));
    await expect(pending).rejects.toMatchObject({ scope: 'run', timeoutMs: 50 });
  });

  it('rejects at once when the parent is already aborted', async () => {
    const parent = new AbortController();
    parent.abort('stop');
    let called = false;
    await expect(
      withDeadline(
        async () => {
          called = true;
        },
        100,
        parent.signal,
      ),
    ).rejects.toThrow('stop');
    expect(called).toBe(false);
  });

  it('propagates task errors, thrown synchronously or not', async () => {
    const signal = new AbortController().signal;
    await expect(
      withDeadline(() => Promise.reject(new Error('async')), 100, signal),
    ).rejects.toThrow('async');
    await expect(
      withDeadline(
        () => {
          throw new Error('sync');
        },
        100,
        signal,
      ),
    ).rejects.toThrow('sync');
  });
});

describe('startRunDeadline', () => {
  it('aborts with a run-scoped DeadlineExceeded', async () => {
    const deadline = startRunDeadline(5, undefined);
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(deadline.signal.reason).toEqual(new DeadlineExceeded('run', 5));
    deadline.dispose();
  });

  it('follows the caller cancellation, even when already cancelled', () => {
    const cancel = new AbortController();
    const deadline = startRunDeadline(1_000, cancel.signal);
    cancel.abort('client left');
    expect(deadline.signal.reason).toBe('client left');
    deadline.dispose();

    const early = startRunDeadline(1_000, cancel.signal);
    expect(early.signal.aborted).toBe(true);
    early.dispose();
  });

  it('stops its timer on dispose', async () => {
    const deadline = startRunDeadline(5, undefined);
    deadline.dispose();
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(deadline.signal.aborted).toBe(false);
  });
});
