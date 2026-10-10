import type { AgentResponseType, FeedbackRequest } from '@wanderly/contracts';
import { useCallback, useId, useMemo, useState } from 'react';
import { numberSources, sourceKey } from '../../lib/sources';
import type { AssistantMessage, RunStats } from '../../lib/types';
import type { FeedbackState } from '../../state/chatReducer';
import { CompassMark } from '../common/icons';
import { FeedbackControls } from '../feedback/FeedbackControls';
import { AnswerView } from '../response/AnswerView';
import type { CitationContext } from '../response/CitationChips';
import { ClarificationView } from '../response/ClarificationView';
import { DeclineView } from '../response/DeclineView';
import { ItineraryView } from '../response/ItineraryView';
import { TransparencyPanel, type SourceFocusRequest } from '../transparency/TransparencyPanel';

interface AssistantMessageViewProps {
  readonly message: AssistantMessage;
  readonly stats: RunStats | undefined;
  readonly illustrativeStats?: boolean;
  readonly feedback: FeedbackState | undefined;
  readonly onFeedback: (runId: string, feedback: FeedbackRequest) => void;
  /** Present only on the latest message, when a reply can be sent now. */
  readonly onQuickReply?: (text: string) => void;
}

const TYPE_LABELS: Readonly<Record<AgentResponseType, string>> = {
  itinerary: 'Itinerary',
  clarification: 'Follow-up questions',
  answer: 'Answer',
  decline: 'Declined',
};

/** One answer of the agent, rendered by type, with its transparency panel and feedback. */
export function AssistantMessageView({
  message,
  stats,
  illustrativeStats = false,
  feedback,
  onFeedback,
  onQuickReply,
}: AssistantMessageViewProps) {
  const panelId = useId();
  const [panelOpen, setPanelOpen] = useState(false);
  const [focusRequest, setFocusRequest] = useState<SourceFocusRequest | null>(null);

  const onCite = useCallback((number: number) => {
    setPanelOpen(true);
    setFocusRequest((previous) => ({ number, seq: (previous?.seq ?? 0) + 1 }));
  }, []);

  const citations = useMemo<CitationContext>(
    () => ({
      numbers: numberSources(message.sources),
      sources: new Map(message.sources.map((source) => [sourceKey(source), source])),
      onCite,
    }),
    [message.sources, onCite],
  );

  const { response } = message;

  return (
    <article
      aria-label={`Wanderly: ${TYPE_LABELS[response.type].toLowerCase()}`}
      className="flex gap-3"
    >
      <CompassMark className="mt-0.5 hidden size-7 shrink-0 text-accent sm:block" />
      <div className="min-w-0 flex-1 space-y-4">
        <p className="flex items-center gap-2 text-sm">
          <span className="font-semibold">Wanderly</span>
          <span className="rounded-full bg-surface-muted px-2 py-0.5 text-xs text-fg-muted">
            {TYPE_LABELS[response.type]}
          </span>
        </p>

        {response.type === 'itinerary' && (
          <>
            <p className="whitespace-pre-line">{response.message}</p>
            <ItineraryView response={response} citations={citations} />
          </>
        )}
        {response.type === 'clarification' && (
          <ClarificationView response={response} onQuickReply={onQuickReply} />
        )}
        {response.type === 'answer' && <AnswerView response={response} citations={citations} />}
        {response.type === 'decline' && <DeclineView response={response} />}

        <TransparencyPanel
          id={panelId}
          sources={message.sources}
          toolCalls={message.toolCalls}
          stats={stats}
          illustrativeStats={illustrativeStats}
          open={panelOpen}
          onOpenChange={setPanelOpen}
          focusRequest={focusRequest}
        />
        <FeedbackControls runId={message.runId} state={feedback} onSubmit={onFeedback} />
      </div>
    </article>
  );
}
