import type { SourceSummary } from '@wanderly/contracts';
import { Fragment, type ReactNode } from 'react';
import { destinationName } from '../../lib/format';
import {
  isWikivoyageUrl,
  licenceFor,
  OPEN_METEO,
  safeExternalUrl,
  SOURCE_KIND_LABELS,
  type Licence,
} from '../../lib/sources';
import { ExternalLink } from '../common/ExternalLink';

interface SourceListProps {
  readonly sources: readonly SourceSummary[];
  /** Prefix of the element ids citation chips focus (`${idPrefix}-${number}`). */
  readonly idPrefix: string;
}

function LicenceText({ licence }: { readonly licence: Licence }) {
  return licence.url === null ? (
    <>{licence.name}</>
  ) : (
    <ExternalLink href={licence.url}>{licence.name}</ExternalLink>
  );
}

/** Where the source comes from and under which licence; weather always credits Open-Meteo. */
function Attribution({ source }: { readonly source: SourceSummary }) {
  const url = safeExternalUrl(source.url);
  const licence = licenceFor(source);
  const parts: ReactNode[] = [];
  if (source.kind === 'weather') {
    parts.push(
      <ExternalLink key="credit" href={OPEN_METEO.url}>
        {OPEN_METEO.text}
      </ExternalLink>,
    );
  } else if (url !== null) {
    const wikivoyage = isWikivoyageUrl(url);
    parts.push(
      <ExternalLink key="link" href={url}>
        {wikivoyage ? 'Wikivoyage revision' : 'Original source'}
      </ExternalLink>,
    );
    if (wikivoyage) {
      parts.push(<span key="authors">text by Wikivoyage contributors</span>);
    }
  }
  if (licence !== null) {
    parts.push(<LicenceText key="licence" licence={licence} />);
  }
  if (parts.length === 0) {
    return null;
  }
  return (
    <p className="text-xs text-fg-muted">
      {parts.map((part, index) => (
        <Fragment key={index}>
          {index > 0 && ' · '}
          {part}
        </Fragment>
      ))}
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
