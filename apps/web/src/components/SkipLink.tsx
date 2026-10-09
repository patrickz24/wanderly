interface SkipLinkProps {
  readonly targetId: string;
}

/** First focusable element: lets keyboard users jump past the header. */
export function SkipLink({ targetId }: SkipLinkProps) {
  return (
    <a
      href={`#${targetId}`}
      className="sr-only focus:not-sr-only focus:fixed focus:top-3 focus:left-3 focus:z-50 focus:rounded-md focus:bg-surface focus:px-4 focus:py-2 focus:text-fg focus:shadow-lg"
    >
      Skip to main content
    </a>
  );
}
