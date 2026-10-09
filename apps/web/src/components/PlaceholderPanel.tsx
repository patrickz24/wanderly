import { useId, type ReactNode } from 'react';

interface PlaceholderPanelProps {
  readonly title: string;
  readonly children: ReactNode;
}

/** Labelled region reserving the space of a feature that is not built yet. */
export function PlaceholderPanel({ title, children }: PlaceholderPanelProps) {
  const headingId = useId();

  return (
    <section
      aria-labelledby={headingId}
      className="flex min-h-64 flex-col rounded-xl border border-line bg-surface p-5 shadow-sm lg:min-h-[28rem]"
    >
      <h2 id={headingId} className="text-lg font-semibold">
        {title}
      </h2>
      <div className="mt-4 flex flex-1 flex-col justify-center gap-2 rounded-lg border-2 border-dashed border-line bg-surface-muted p-6 text-center text-sm text-fg-muted">
        {children}
      </div>
    </section>
  );
}
