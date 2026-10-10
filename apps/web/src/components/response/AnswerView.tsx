import type { AgentResponseOf } from '../../lib/types';
import { CitationChips, type CitationContext } from './CitationChips';

interface AnswerViewProps {
  readonly response: AgentResponseOf<'answer'>;
  readonly citations: CitationContext;
}

/** A direct answer to a travel question, with the sources it relies on. */
export function AnswerView({ response, citations }: AnswerViewProps) {
  return (
    <div className="space-y-3">
      <p className="whitespace-pre-line">{response.message}</p>
      {response.sourceRefs.length > 0 && (
        <div className="flex flex-wrap items-center gap-2 text-sm text-fg-muted">
          <span aria-hidden="true">Sources</span>
          <CitationChips refs={response.sourceRefs} context={citations} />
        </div>
      )}
    </div>
  );
}
