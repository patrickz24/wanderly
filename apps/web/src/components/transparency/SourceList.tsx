import type { SourceSummary } from '@wanderly/contracts';
import { destinationName } from '../../lib/format';
import {
  isWikivoyageUrl,
  OPEN_METEO,
  safeExternalUrl,
  SOURCE_KIND_LABELS,
  WIKIVOYAGE_LICENSE,
} from '../../lib/sources';
import { ExternalLink } from '../common/ExternalLink';

interface SourceListProps {
  readonly sources: readonly SourceSummary[];
  /** Prefix of the element ids citation chips focus (`${idPrefix}-${number}`). */
  readonly idPrefix: string;
}

function Attribution({ source }: { readonly source: SourceSummary }) {
  const url = safeExternalUrl(source.url);
  if (source.kind === 'weather') {
    return (
      <p className="text-xs text-fg-muted">
        <ExternalLink href={OPEN_METEO.url}>{OPEN_METEO.text}</ExternalLink>
        {' (CC BY 4.0)'}
      </p>
    );
  }
  if (url === null) {
    return null;
  }
  if (isWikivoyageUrl(url)) {
    return (
      <p className="text-xs text-fg-muted">
        <ExternalLink href={url}>Wikivoyage revision</ExternalLink>
        {' · text by Wikivoyage contributors, '}
        <ExternalLink href={WIKIVOYAGE_LICENSE.url}>{WIKIVOYAGE_LICENSE.name}</ExternalLink>
      </p>
    );
  }
  return (
    <p className="text-xs text-fg-muted">
      <ExternalLink href={url}>Original source</ExternalLink>
    </p>
  );
}

/** Numbered like the citation chips, so "2" in the answer is item 2 here. */
export function SourceList({ sources, idPrefix }: SourceListProps) {
  if (sources.length === 0) {
    return <p className="text-sm text-fg-muted">This answer cites no sources.</p>;
  }
  return (
    <ol className="space-y-3">
      {sources.map((source, index) => (
        <li
          key={`${source.kind}:${source.id}`}
          id={`${idPrefix}-${index + 1}`}
          tabIndex={-1}
          className="scroll-mt-24 rounded-lg border border-line bg-surface p-3 focus:outline-2 focus:outline-offset-2 focus:outline-focus"
        >
          <div className="flex flex-wrap items-baseline gap-x-2 gap-y-1">
            <span className="text-sm font-semibold text-accent tabular-nums">{index + 1}.</span>
            <span className="font-medium">{source.title}</span>
            <span className="rounded-full bg-surface-muted px-2 py-0.5 text-xs text-fg-muted">
              {SOURCE_KIND_LABELS[source.kind]}
              {source.destinationId !== null && ` · ${destinationName(source.destinationId)}`}
            </span>
          </div>
          {source.snippet !== null && (
            <blockquote className="mt-2 border-l-2 border-line pl-3 text-sm text-fg-muted">
              {source.snippet}
            </blockquote>
          )}
          <div className="mt-2">
            <Attribution source={source} />
          </div>
        </li>
      ))}
    </ol>
  );
}
