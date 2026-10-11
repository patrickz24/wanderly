/* eslint-disable @typescript-eslint/no-unused-vars -- learning skeleton: the parameters are used once the TODOs are implemented; remove this line at the end. */
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
  // TODO(learning) — étape 2. Spec : deadline.test.ts, describe('withDeadline').
  // 1. Parent déjà annulé : rejette tout de suite (avec `toError(parent.reason)`), sans lancer
  //    la tâche.
  // 2. Crée un AbortController pour la tâche, puis une Promise qui fait la COURSE entre trois
  //    événements :
  //    - la tâche se termine (succès ou échec) ;
  //    - ton minuteur expire : annule le contrôleur et rejette avec `DeadlineExceeded('call', …)` ;
  //    - le parent annule : annule le contrôleur et rejette avec la raison du parent.
  // 3. Quel que soit le gagnant : arrête le minuteur et retire l'écouteur posé sur le parent
  //    (sinon fuite mémoire : le signal du run vit tout le run).
  // 4. Une tâche peut aussi lever une exception SYNCHRONE avant de rendre sa promesse : elle doit
  //    devenir un rejet, pas une exception qui s'échappe de `withDeadline`.
  // Point clé : on rend la main à l'heure MÊME SI la tâche ignore son signal. Le résultat tardif
  // est simplement jeté (une promesse ne se résout qu'une fois).
  throw new Error('TODO(learning): withDeadline (agent-loop, step 2)');
}

export interface RunDeadline {
  /** Aborted at the run deadline (reason: `DeadlineExceeded('run')`) or on cancellation. */
  readonly signal: AbortSignal;
  dispose(): void;
}

/** Starts the run's deadline timer, linked to the caller's cancellation signal if any. */
export function startRunDeadline(timeoutMs: number, cancel: AbortSignal | undefined): RunDeadline {
  // TODO(learning) — étape 2. Spec : deadline.test.ts, describe('startRunDeadline').
  // 1. Un AbortController pour le run, annulé par un minuteur avec `DeadlineExceeded('run', …)`.
  // 2. Relie-le à l'annulation de l'appelant (`cancel`, optionnel) : même raison d'annulation.
  //    Attention au cas où `cancel` est DÉJÀ annulé : un écouteur 'abort' ne se déclencherait
  //    jamais.
  // 3. `dispose()` arrête le minuteur et retire l'écouteur : `runAgent` l'appelle dans un `finally`.
  throw new Error('TODO(learning): startRunDeadline (agent-loop, step 2)');
}

function toError(reason: unknown): Error {
  return reason instanceof Error ? reason : new Error(String(reason));
}
