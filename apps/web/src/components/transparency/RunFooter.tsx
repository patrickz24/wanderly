import { formatDuration, formatInteger, formatUsd } from '../../lib/format';
import type { RunStats } from '../../lib/types';

interface RunFooterProps {
  readonly stats: RunStats | undefined;
  /** Demo mode: the figures are fixture values, not measurements. */
  readonly illustrative?: boolean;
}

/** What the run cost: LLM steps, tokens, dollars and wall-clock time. */
export function RunFooter({ stats, illustrative = false }: RunFooterProps) {
  if (stats === undefined) {
    return (
      <p className="text-xs text-fg-muted">
        Run statistics are only available for answers produced during this visit.
      </p>
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
      {illustrative && (
        <p className="text-xs text-fg-muted">Illustrative values (demo mode), not measurements.</p>
      )}
      {stats.traceId !== null && (
        <p className="text-xs text-fg-muted">
          Trace reference <code>{stats.traceId}</code>
        </p>
      )}
    </div>
  );
}
