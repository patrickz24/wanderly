import type { ReactNode } from 'react';

interface AppHeaderProps {
  /** Right-hand slot, e.g. the API status indicator. */
  readonly status?: ReactNode;
}

function CompassIcon() {
  return (
    <svg
      aria-hidden="true"
      focusable="false"
      viewBox="0 0 32 32"
      className="size-8 shrink-0 text-accent"
    >
      <circle cx="16" cy="16" r="14" fill="currentColor" />
      <path d="M16 6l4 10-4 10-4-10z" className="fill-surface" />
      <circle cx="16" cy="16" r="2" fill="currentColor" />
    </svg>
  );
}

export function AppHeader({ status }: AppHeaderProps) {
  return (
    <header className="border-b border-line bg-surface">
      <div className="mx-auto flex max-w-6xl flex-wrap items-center justify-between gap-x-6 gap-y-3 px-4 py-4 sm:px-6">
        <div className="flex items-center gap-3">
          <CompassIcon />
          <div>
            <h1 className="text-xl font-semibold tracking-tight">Wanderly</h1>
            <p className="text-sm text-fg-muted">Agentic travel planning that shows its sources.</p>
          </div>
        </div>
        {status}
      </div>
    </header>
  );
}
