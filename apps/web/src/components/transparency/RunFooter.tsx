import { formatDuration, formatInteger, formatUsd } from '../../lib/format';
import type { RunStats } from '@wanderly/contracts';

interface RunFooterProps {
  readonly stats: RunStats | undefined;
}

/** What the run cost: LLM steps, tokens, dollars and wall-clock time. */
export function RunFooter({ stats }: RunFooterProps) {
  if (stats === undefined) {
    return (
      <p className="text-xs text-fg-muted">Run statistics are not available for this answer.</p>
    );
  }
  const { usage } = stats;
  const items: readonly [string, string][] = [
    ['Steps', formatInteger(stats.steps)],
    [
      'Tokens',
      `${formatInteger(usage.inputTokens)} in · ${formatInteger(usage.outputTokens)} out` +
        (usage.cacheReadTokens > 0 ? ` · ${formatInteger(usage.cacheReadTokens)} cached` : ''),
    ],
    ['Cost', formatUsd(stats.costUsd)],
    ['Latency', formatDuration(stats.latencyMs)],
  ];
  return (
    <div className="space-y-1">
      <dl className="flex flex-wrap gap-x-5 gap-y-1 text-xs">
        {items.map(([label, value]) => (
          <div key={label} className="flex gap-1.5">
            <dt className="text-fg-muted">{label}</dt>
            <dd className="font-medium tabular-nums">{value}</dd>
          </div>
        ))}
      </dl>
      {stats.traceId !== null && (
        <p className="text-xs text-fg-muted">
          Trace reference <code>{stats.traceId}</code>
        </p>
      )}
    </div>
  );
}
