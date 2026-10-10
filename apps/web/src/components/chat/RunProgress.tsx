import { useDisplayOptions } from '../../lib/displayOptions';
import { formatDuration } from '../../lib/format';
import { describeToolCall } from '../../lib/toolLabels';
import type { ActiveRun, ToolStep } from '../../state/chatReducer';
import { CheckIcon, CrossIcon, SpinnerIcon } from '../common/icons';

interface RunProgressProps {
  readonly run: ActiveRun;
}

function StepStatus({ step }: { readonly step: ToolStep }) {
  const { showMeasurements } = useDisplayOptions();
  const duration =
    showMeasurements && step.durationMs !== null ? formatDuration(step.durationMs) : null;
  switch (step.status) {
    case 'running':
      return <span className="sr-only">in progress</span>;
    case 'ok':
      return duration === null ? (
        <span className="sr-only">done</span>
      ) : (
        <span className="text-xs text-fg-muted tabular-nums">
          <span className="sr-only">done in </span>
          {duration}
        </span>
      );
    case 'error':
      return (
        <span className="text-xs font-medium text-danger tabular-nums">
          failed{duration === null ? '' : ` after ${duration}`}
        </span>
      );
  }
}

function StepIcon({ step }: { readonly step: ToolStep }) {
  switch (step.status) {
    case 'running':
      return <SpinnerIcon className="size-4 text-accent" />;
    case 'ok':
      return <CheckIcon className="size-4 text-success" />;
    case 'error':
      return <CrossIcon className="size-4 text-danger" />;
  }
}

function phaseLabel(run: ActiveRun): string {
  if (run.responded) {
    return 'Wrapping up…';
  }
  if (run.runId === null) {
    return 'Sending your message…';
  }
  return run.tools.some((step) => step.status === 'running') ? 'Working on it…' : 'Thinking…';
}

/**
 * Live timeline of the run, built from `tool.*` events. A polite live region announces each
 * step and its outcome; failed tools stay visible, because the agent adapts to them and the
 * user should know.
 */
export function RunProgress({ run }: RunProgressProps) {
  return (
    <section aria-label="Agent progress" className="flex gap-3">
      <SpinnerIcon className="mt-0.5 hidden size-7 shrink-0 p-1 text-accent sm:block" />
      <div className="min-w-0 flex-1 rounded-lg border border-line bg-surface-muted/60 p-3">
        <p role="status" className="text-sm font-medium">
          {phaseLabel(run)}
        </p>
        {run.tools.length > 0 && (
          <ol aria-live="polite" aria-label="Steps" className="mt-2 space-y-1.5">
            {run.tools.map((step) => (
              <li key={step.callId} className="flex items-start gap-2 text-sm">
                <span className="mt-0.5 shrink-0">
                  <StepIcon step={step} />
                </span>
                <span className="min-w-0 flex-1">
                  <span className="flex flex-wrap items-baseline justify-between gap-x-3">
                    <span>{describeToolCall(step.name, step.input)}</span>
                    <StepStatus step={step} />
                  </span>
                  {step.status === 'error' && step.summary !== null && step.summary !== '' && (
                    <span className="block text-xs text-danger">{step.summary}</span>
                  )}
                </span>
              </li>
            ))}
          </ol>
        )}
      </div>
    </section>
  );
}
