import { quickRepliesFor } from '../../lib/quickReplies';
import type { AgentResponseOf } from '../../lib/types';

interface ClarificationViewProps {
  readonly response: AgentResponseOf<'clarification'>;
  /** Present only when replying is possible now (latest message, no run in flight). */
  readonly onQuickReply?: (text: string) => void;
}

/** Follow-up questions, with one-click answers for simple choices. */
export function ClarificationView({ response, onQuickReply }: ClarificationViewProps) {
  const { questions, brief } = response;

  return (
    <div className="space-y-3">
      <p className="whitespace-pre-line">{response.message}</p>
      <ol className="space-y-3">
        {questions.map((question, index) => {
          const replies = onQuickReply
            ? quickRepliesFor(question, { questionCount: questions.length, brief })
            : [];
          return (
            <li key={question} className="rounded-lg border border-line bg-surface-muted p-3">
              <p className="font-medium">
                <span className="mr-2 text-accent">{index + 1}.</span>
                {question}
              </p>
              {onQuickReply && replies.length > 0 && (
                <div
                  role="group"
                  aria-label={`Quick replies to question ${index + 1}`}
                  className="mt-2 flex flex-wrap gap-2"
                >
                  {replies.map((reply) => (
                    <button
                      key={reply}
                      type="button"
                      onClick={() => onQuickReply(reply)}
                      className="rounded-full border border-accent/50 bg-surface px-3 py-1 text-sm font-medium text-accent hover:bg-accent/10"
                    >
                      {reply}
                    </button>
                  ))}
                </div>
              )}
            </li>
          );
        })}
      </ol>
    </div>
  );
}
