/** Explains demo mode wherever it is on, so screenshots cannot pass for live answers. */
export function DemoModeBanner() {
  return (
    <aside aria-label="Demo mode" className="border-b border-line bg-surface-muted">
      <div className="mx-auto flex max-w-6xl flex-wrap items-center justify-between gap-x-6 gap-y-2 px-4 py-2 text-sm sm:px-6">
        <p>
          <strong className="font-semibold">Demo mode: sample data.</strong> These conversations are
          built from Wanderly’s Sicily guide (Wikivoyage) and Open-Meteo climate data. No AI model
          is called: a new message replays a recorded answer. Nothing is measured, so no timing,
          token or cost figure is shown.
        </p>
        <a href="/" className="shrink-0 font-medium underline underline-offset-2">
          Leave demo mode
        </a>
      </div>
    </aside>
  );
}

/** Replaces the API status in the header while in demo mode. */
export function DemoBadge() {
  return (
    <p className="inline-flex items-center gap-2 rounded-full border border-line bg-surface-muted px-3 py-1 text-sm">
      <span aria-hidden="true" className="size-2.5 shrink-0 rounded-full bg-pending" />
      Demo mode (offline)
    </p>
  );
}
