import { EXAMPLE_PROMPTS } from '../../lib/examples';
import { CompassMark } from '../common/icons';

interface EmptyStateProps {
  /** Puts the prompt in the composer, so it can be edited before sending. */
  readonly onPickExample: (prompt: string) => void;
}

export function EmptyState({ onPickExample }: EmptyStateProps) {
  return (
    <div className="mx-auto flex max-w-xl flex-col items-center gap-4 py-8 text-center">
      <CompassMark className="size-10 text-accent" />
      <div className="space-y-1">
        <p className="text-lg font-semibold">Where to next?</p>
        <p className="text-sm text-fg-muted">
          Describe a trip in your own words. Wanderly asks when something is unclear, checks its
          travel guide, weather and budget tools, and shows every source it used. It covers 20
          European destinations.
        </p>
      </div>
      <div className="w-full space-y-2">
        <p className="text-xs font-semibold tracking-wide text-fg-muted uppercase">
          Try an example
        </p>
        <ul className="space-y-2">
          {EXAMPLE_PROMPTS.map((prompt) => (
            <li key={prompt}>
              <button
                type="button"
                onClick={() => onPickExample(prompt)}
                className="w-full rounded-lg border border-line bg-surface px-4 py-3 text-left text-sm hover:border-accent hover:bg-accent/5"
              >
                {prompt}
              </button>
            </li>
          ))}
        </ul>
      </div>
    </div>
  );
}
