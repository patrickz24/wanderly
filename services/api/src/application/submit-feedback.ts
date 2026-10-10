import type { FeedbackRequest } from '@wanderly/contracts';
import { NotFoundError } from '../domain/errors.js';
import type { Clock, Tracer } from '../domain/ports/tracer.js';
import type { FeedbackRepository, RunRepository } from './ports/runs.js';

/** Score name of the user's thumbs up (+1) / thumbs down (-1) in Langfuse. */
export const USER_FEEDBACK_SCORE = 'user_feedback';

export interface SubmitFeedbackDeps {
  readonly runs: RunRepository;
  readonly feedback: FeedbackRepository;
  readonly tracer: Tracer;
  readonly clock: Clock;
}

export interface SubmitFeedbackCommand extends FeedbackRequest {
  readonly sessionId: string;
  readonly runId: string;
}

export interface SubmitFeedback {
  /** Throws `NotFoundError` unless the run belongs to one of the session's conversations. */
  execute(command: SubmitFeedbackCommand): Promise<void>;
}

export function createSubmitFeedback({
  runs,
  feedback,
  tracer,
  clock,
}: SubmitFeedbackDeps): SubmitFeedback {
  return {
    async execute({ sessionId, runId, rating, comment }) {
      const run = await runs.findForSession(runId, sessionId);
      if (run === null) throw new NotFoundError('run', runId);

      const normalizedComment = comment === null || comment === '' ? null : comment;
      await feedback.upsert({
        runId: run.id,
        rating,
        comment: normalizedComment,
        createdAt: clock.now(),
      });
      // The database is the source of truth; the score makes it visible next to the trace.
      if (run.traceId !== null) {
        tracer.scoreTrace(run.traceId, USER_FEEDBACK_SCORE, rating, normalizedComment ?? undefined);
      }
    },
  };
}
