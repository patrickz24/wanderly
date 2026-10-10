import { DECLINE_EXPLANATIONS } from '../../lib/declineReasons';
import type { AgentResponseOf } from '../../lib/types';
import { InfoIcon } from '../common/icons';

interface DeclineViewProps {
  readonly response: AgentResponseOf<'decline'>;
}

/** A calm, reason-specific notice explaining why the assistant will not answer. */
export function DeclineView({ response }: DeclineViewProps) {
  const { title, explanation } = DECLINE_EXPLANATIONS[response.reason];
  return (
    <div className="flex gap-3 rounded-lg border border-line bg-surface-muted p-4">
      <InfoIcon className="mt-0.5 size-5 shrink-0 text-fg-muted" />
      <div className="space-y-2">
        <p className="font-semibold">{title}</p>
        <p className="whitespace-pre-line">{response.message}</p>
        <p className="text-sm text-fg-muted">{explanation}</p>
      </div>
    </div>
  );
}
