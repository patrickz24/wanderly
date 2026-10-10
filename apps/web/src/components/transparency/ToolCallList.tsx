import type { ToolCallSummary } from '@wanderly/contracts';
import { useDisplayOptions } from '../../lib/displayOptions';
import { formatDuration } from '../../lib/format';
import { describeToolCall } from '../../lib/toolLabels';
import { CheckIcon, CrossIcon } from '../common/icons';

interface ToolCallListProps {
  readonly toolCalls: readonly ToolCallSummary[];
}

function prettyJson(value: unknown): string {
  try {
    return JSON.stringify(value, null, 2) ?? 'undefined';
  } catch {
    return String(value);
  }
}

/** Every tool the agent called for this answer, failures included. */
export function ToolCallList({ toolCalls }: ToolCallListProps) {
  const { showMeasurements } = useDisplayOptions();
  if (toolCalls.length === 0) {
    return <p className="text-sm text-fg-muted">No tool was called for this answer.</p>;
  }
  return (
    <ol className="space-y-2">
      {toolCalls.map((call) => (
        <li key={call.callId} className="rounded-lg border border-line bg-surface p-3 text-sm">
          <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
            <code className="rounded bg-surface-muted px-1.5 py-0.5 text-xs">{call.name}</code>
            <span
              className={`inline-flex items-center gap-1 text-xs font-medium ${call.ok ? 'text-success' : 'text-danger'}`}
            >
              {call.ok ? <CheckIcon className="size-3.5" /> : <CrossIcon className="size-3.5" />}
              {call.ok ? 'OK' : 'Error'}
            </span>
            <span className="text-xs text-fg-muted tabular-nums">
              {formatDuration(call.durationMs)}
            </span>
          </div>
          <p className="mt-1.5">{describeToolCall(call.name, call.input)}</p>
          {call.summary !== '' && (
            <p className={`mt-1 ${call.ok ? 'text-fg-muted' : 'text-danger'}`}>{call.summary}</p>
          )}
          <details className="mt-2">
            <summary className="cursor-pointer text-xs font-medium text-fg-muted hover:text-fg">
              Input
            </summary>
            <pre className="mt-1 max-h-60 overflow-auto rounded-md bg-surface-muted p-2 text-xs">
              <code>{prettyJson(call.input)}</code>
            </pre>
          </details>
        </li>
      ))}
    </ol>
  );
}
