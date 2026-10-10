import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './App';
import { ErrorBoundary } from './components/ErrorBoundary';
import { isDemoMode } from './demo/demoMode';
import type { ChatTransport } from './lib/chatApi';
import './index.css';

const container = document.getElementById('root');
if (container === null) {
  throw new Error('index.html must contain an element with id "root".');
}
const root = createRoot(container);

async function start(): Promise<void> {
  const demo = isDemoMode(window.location.search);
  let transport: ChatTransport | undefined;
  let initialConversationId: string | null = null;
  if (demo) {
    // Loaded on demand: the sample data never weighs on the normal bundle.
    const [{ createDemoTransport }, { DEMO_IDS }] = await Promise.all([
      import('./demo/demoTransport'),
      import('./demo/fixtures'),
    ]);
    transport = createDemoTransport();
    initialConversationId = DEMO_IDS.hikingTrip;
  }
  root.render(
    <StrictMode>
      <ErrorBoundary>
        <App demo={demo} transport={transport} initialConversationId={initialConversationId} />
      </ErrorBoundary>
    </StrictMode>,
  );
}

void start();
