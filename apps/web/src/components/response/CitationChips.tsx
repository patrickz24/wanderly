import type { SourceRef, SourceSummary } from '@wanderly/contracts';
import { SOURCE_KIND_LABELS, sourceKey } from '../../lib/sources';

export interface CitationContext {
  /** Footnote number of each source of the answer, by `sourceKey`. */
  readonly numbers: ReadonlyMap<string, number>;
  readonly sources: ReadonlyMap<string, SourceSummary>;
  /** Opens the transparency panel on source `number`. */
  readonly onCite: (number: number) => void;
}

interface CitationChipsProps {
  readonly refs: readonly SourceRef[];
  readonly context: CitationContext;
  readonly className?: string;
}

/**
 * Footnote-style chips: each cites a source returned by the run's tools and jumps to it in the
 * transparency panel. A reference the answer's sources do not contain is shown as such rather
 * than hidden: grounding problems must stay visible.
 */
export function CitationChips({ refs, context, className = '' }: CitationChipsProps) {
  if (refs.length === 0) {
    return null;
  }
  const unique = [...new Map(refs.map((ref) => [sourceKey(ref), ref])).values()];

  return (
    <ul aria-label="Sources" className={`flex flex-wrap gap-1.5 ${className}`}>
      {unique.map((ref) => {
        const key = sourceKey(ref);
        const number = context.numbers.get(key);
        const source = context.sources.get(key);
        if (number === undefined || source === undefined) {
          return (
            <li key={key}>
              <span className="inline-flex items-center rounded-md border border-dashed border-line px-1.5 py-0.5 text-xs text-fg-muted">
                Unlisted source
              </span>
            </li>
          );
        }
        return (
          <li key={key}>
            <button
              type="button"
              onClick={() => context.onCite(number)}
              aria-label={`Source ${number}: ${source.title} (${SOURCE_KIND_LABELS[source.kind].toLowerCase()})`}
              title={source.title}
              className="inline-flex min-w-7 items-center justify-center gap-1 rounded-md border border-accent/40 bg-accent/10 px-1.5 py-0.5 text-xs font-semibold text-accent tabular-nums hover:bg-accent/20"
            >
              {number}
            </button>
          </li>
        );
      })}
    </ul>
  );
}
