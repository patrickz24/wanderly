import { useCallback, useRef, useState } from 'react';
import type { ChatTransport } from '../../lib/chatApi';
import { useChat } from '../../state/useChat';
import { useConversationList } from '../../state/useConversationList';
import { ConversationPanel } from './ConversationPanel';
import { TripList } from './TripList';

interface ChatAppProps {
  readonly transport: ChatTransport;
  /** Conversation to open on load (demo mode opens its sample trip). */
  readonly initialConversationId?: string | null;
}

/** The chat feature: trip list on the side, the open conversation in the main column. */
export function ChatApp({ transport, initialConversationId = null }: ChatAppProps) {
  const list = useConversationList(transport);
  const chat = useChat(transport, {
    initialConversationId,
    onConversationsChanged: list.refresh,
  });
  const [draft, setDraft] = useState('');
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const headingRef = useRef<HTMLHeadingElement>(null);
  const { send, startNewConversation, openConversation } = chat;

  const focusComposer = useCallback(() => {
    textareaRef.current?.focus();
  }, []);

  const handleSend = useCallback(
    (text: string) => {
      setDraft('');
      void send(text).then((outcome) => {
        // The server never accepted the message: give the text back instead of losing it.
        if (outcome === 'not-delivered') {
          setDraft((current) => (current === '' ? text : current));
        }
      });
    },
    [send],
  );

  const handlePickExample = useCallback(
    (prompt: string) => {
      setDraft(prompt);
      focusComposer();
    },
    [focusComposer],
  );

  const handleOpenTrip = useCallback(
    (id: string) => {
      openConversation(id);
      headingRef.current?.focus();
    },
    [openConversation],
  );

  const handleNewTrip = useCallback(() => {
    startNewConversation();
    setDraft('');
    focusComposer();
  }, [startNewConversation, focusComposer]);

  return (
    <div className="grid items-start gap-6 lg:grid-cols-[16rem_minmax(0,1fr)]">
      <TripList
        state={list.state}
        activeId={chat.state.conversationId}
        onSelect={handleOpenTrip}
        onNewTrip={handleNewTrip}
        onRetry={list.refresh}
      />
      <ConversationPanel
        state={chat.state}
        draft={draft}
        onDraftChange={setDraft}
        onSend={handleSend}
        onStop={chat.stop}
        onPickExample={handlePickExample}
        onFeedback={chat.sendFeedback}
        onDismissError={chat.dismissError}
        onStartNew={handleNewTrip}
        textareaRef={textareaRef}
        headingRef={headingRef}
      />
    </div>
  );
}
