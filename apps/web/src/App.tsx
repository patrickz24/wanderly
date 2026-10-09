import { AppHeader } from './components/AppHeader';
import { DemoNotice } from './components/DemoNotice';
import { PlaceholderPanel } from './components/PlaceholderPanel';
import { SkipLink } from './components/SkipLink';

const MAIN_ID = 'main';

export function App() {
  return (
    <div className="flex min-h-dvh flex-col">
      <SkipLink targetId={MAIN_ID} />
      <AppHeader />
      <DemoNotice />
      <main
        id={MAIN_ID}
        tabIndex={-1}
        className="mx-auto grid w-full max-w-6xl flex-1 grid-cols-1 gap-6 px-4 py-6 focus:outline-none sm:px-6 lg:grid-cols-[minmax(0,3fr)_minmax(0,2fr)]"
      >
        <PlaceholderPanel title="Conversation">
          <p>
            Describe the trip you have in mind: destination, dates, budget, pace. The planning agent
            asks follow-up questions when something is unclear.
          </p>
          <p className="font-medium">The chat is coming soon.</p>
        </PlaceholderPanel>
        <PlaceholderPanel title="Itinerary and sources">
          <p>
            Your day-by-day itinerary will appear here, next to the guide excerpts and tools the
            agent used to build it.
          </p>
        </PlaceholderPanel>
      </main>
    </div>
  );
}
