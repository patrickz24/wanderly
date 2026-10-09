/** Privacy and scope disclaimer, visible on every screen. Wording is part of the product contract. */
export const DEMO_NOTICE_TEXT =
  'Personal demo project — fictional brand. Do not enter personal information. Conversations are stored for 30 days.';

export function DemoNotice() {
  return (
    <aside
      aria-label="Demo notice"
      className="border-b border-notice-line bg-notice text-notice-fg"
    >
      <p className="mx-auto max-w-6xl px-4 py-2 text-sm sm:px-6">{DEMO_NOTICE_TEXT}</p>
    </aside>
  );
}
