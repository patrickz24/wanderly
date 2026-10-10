import type { ChatUserMessage } from '../../state/chatReducer';

interface UserMessageViewProps {
  readonly message: ChatUserMessage;
}

/** The traveller's message; shown at once (optimistically) and marked until confirmed. */
export function UserMessageView({ message }: UserMessageViewProps) {
  return (
    <div className="flex justify-end">
      <div
        className={`max-w-[85%] rounded-2xl rounded-br-sm bg-accent px-4 py-2.5 whitespace-pre-wrap text-surface ${message.pending ? 'opacity-75' : ''}`}
      >
        <span className="sr-only">You: </span>
        {message.text}
        {message.pending && <span className="sr-only"> (sending)</span>}
      </div>
    </div>
  );
}
