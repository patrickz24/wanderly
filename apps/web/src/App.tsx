import { useState } from 'react';
import { ApiStatusIndicator } from './components/ApiStatusIndicator';
import { AppHeader } from './components/AppHeader';
import { ChatApp } from './components/chat/ChatApp';
import { DemoBadge, DemoModeBanner } from './components/DemoModeBanner';
import { DemoNotice } from './components/DemoNotice';
import { SiteFooter } from './components/SiteFooter';
import { SkipLink } from './components/SkipLink';
import { httpTransport, type ChatTransport } from './lib/chatApi';
import { DEMO_DISPLAY, DisplayOptionsContext, LIVE_DISPLAY } from './lib/displayOptions';

const MAIN_ID = 'main';

interface AppProps {
  /** Demo mode: sample data, no API (see `src/demo`). */
  readonly demo?: boolean;
  /** Overrides the transport (demo mode, tests). Defaults to the HTTP API. */
  readonly transport?: ChatTransport;
  /** Conversation opened on load. */
  readonly initialConversationId?: string | null;
}

export function App({ demo = false, transport, initialConversationId = null }: AppProps) {
  // Chosen once: swapping transports mid-session would mix two data sources.
  const [chatTransport] = useState<ChatTransport>(() => transport ?? httpTransport);

  return (
    <div className="flex min-h-dvh flex-col">
      <SkipLink targetId={MAIN_ID} />
      <AppHeader status={demo ? <DemoBadge /> : <ApiStatusIndicator />} />
      <DemoNotice />
      {demo && <DemoModeBanner />}
      <main
        id={MAIN_ID}
        tabIndex={-1}
        className="mx-auto w-full max-w-6xl flex-1 px-4 py-6 focus:outline-none sm:px-6"
      >
        <DisplayOptionsContext value={demo ? DEMO_DISPLAY : LIVE_DISPLAY}>
          <ChatApp transport={chatTransport} initialConversationId={initialConversationId} />
        </DisplayOptionsContext>
      </main>
      <SiteFooter />
    </div>
  );
}
