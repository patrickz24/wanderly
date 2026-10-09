import { useApiStatus, type ApiStatus } from '../hooks/useApiStatus';
import { getHealth } from '../lib/api';

interface ApiStatusIndicatorProps {
  readonly pollIntervalMs?: number;
}

const PRESENTATION = {
  checking: { label: 'Checking API…', dot: 'bg-pending animate-pulse' },
  online: { label: 'API online', dot: 'bg-success' },
  unavailable: { label: 'API unavailable', dot: 'bg-danger' },
} as const satisfies Record<ApiStatus['state'], { label: string; dot: string }>;

/** Live liveness badge. The text carries the meaning; the coloured dot is decorative. */
export function ApiStatusIndicator({ pollIntervalMs }: ApiStatusIndicatorProps) {
  const status = useApiStatus(getHealth, pollIntervalMs);
  const { label, dot } = PRESENTATION[status.state];

  return (
    <p
      role="status"
      aria-live="polite"
      className="inline-flex items-center gap-2 rounded-full border border-line bg-surface-muted px-3 py-1 text-sm"
    >
      <span aria-hidden="true" className={`size-2.5 shrink-0 rounded-full ${dot}`} />
      <span>{label}</span>
      {status.state === 'unavailable' && <span className="text-fg-muted">({status.detail})</span>}
    </p>
  );
}
