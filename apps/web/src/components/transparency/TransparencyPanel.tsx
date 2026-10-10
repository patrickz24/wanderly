import type { SourceSummary, ToolCallSummary } from '@wanderly/contracts';
import { useEffect, type SyntheticEvent } from 'react';
import { useDisplayOptions } from '../../lib/displayOptions';
import { plural } from '../../lib/format';
import type { RunStats } from '@wanderly/contracts';
import { RunFooter } from './RunFooter';
import { SourceList } from './SourceList';
import { ToolCallList } from './ToolCallList';

/** A request to bring source `number` into view; `seq` makes repeated clicks count. */
export interface SourceFocusRequest {
  readonly number: number;
  readonly seq: number;
}

interface TransparencyPanelProps {
  readonly id: string;
  readonly sources: readonly SourceSummary[];
  readonly toolCalls: readonly ToolCallSummary[];
  readonly stats: RunStats | undefined;
  readonly open: boolean;
  readonly onOpenChange: (open: boolean) => void;
  readonly focusRequest: SourceFocusRequest | null;
}

/**
 * "How was this answer made": the sources it cites, every tool call, and what the run cost.
 * Collapsed by default; citation chips open it on the cited source.
 */
export function TransparencyPanel({
  id,
  sources,
  toolCalls,
  stats,
  open,
  onOpenChange,
  focusRequest,
}: TransparencyPanelProps) {
  const { showMeasurements } = useDisplayOptions();
  const sourceIdPrefix = `${id}-source`;

  useEffect(() => {
    if (focusRequest === null) {
      return;
    }
    // Runs after the commit that opened the panel, so the target is rendered and focusable.
    document.getElementById(`${sourceIdPrefix}-${focusRequest.number}`)?.focus();
  }, [focusRequest, sourceIdPrefix]);

  const handleToggle = (event: SyntheticEvent<HTMLDetailsElement>): void => {
    onOpenChange(event.currentTarget.open);
  };

  return (
    <details
      id={id}
      open={open}
      onToggle={handleToggle}
      className="group rounded-lg border border-line bg-surface-muted/60"
    >
      <summary className="flex cursor-pointer list-none items-center justify-between gap-3 rounded-lg px-4 py-2.5 text-sm font-medium hover:bg-surface-muted [&::-webkit-details-marker]:hidden">
        <span>
          Sources and tools
          <span className="ml-2 font-normal text-fg-muted">
            {plural(sources.length, 'source')} · {plural(toolCalls.length, 'tool call')}
          </span>
        </span>
        <span
          aria-hidden="true"
          className="inline-block text-fg-muted transition-transform group-open:rotate-180"
        >
          ▾
        </span>
      </summary>
      <div className="space-y-5 border-t border-line px-4 py-4">
        <section className="space-y-2">
          <h4 className="text-sm font-semibold">Sources</h4>
          <SourceList sources={sources} idPrefix={sourceIdPrefix} />
        </section>
        <section className="space-y-2">
          <h4 className="text-sm font-semibold">Tool calls</h4>
          <ToolCallList toolCalls={toolCalls} />
        </section>
        {showMeasurements && (
          <section className="space-y-2 border-t border-line pt-3">
            <h4 className="text-sm font-semibold">Run</h4>
            <RunFooter stats={stats} />
          </section>
        )}
      </div>
    </details>
  );
}
