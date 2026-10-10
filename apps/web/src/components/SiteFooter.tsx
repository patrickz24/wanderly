import { OPEN_METEO, WIKIVOYAGE_LICENSE } from '../lib/sources';
import { ExternalLink } from './common/ExternalLink';

/** Licence attributions required by the corpus, and a reminder that answers can be wrong. */
export function SiteFooter() {
  return (
    <footer className="border-t border-line bg-surface">
      <div className="mx-auto max-w-6xl space-y-1 px-4 py-4 text-xs text-fg-muted sm:px-6">
        <p>
          Travel guide content from{' '}
          <ExternalLink href="https://en.wikivoyage.org/">Wikivoyage</ExternalLink> contributors,
          licensed under{' '}
          <ExternalLink href={WIKIVOYAGE_LICENSE.url}>{WIKIVOYAGE_LICENSE.name}</ExternalLink>.{' '}
          <ExternalLink href={OPEN_METEO.url}>{OPEN_METEO.text}</ExternalLink> (CC BY 4.0).
        </p>
        <p>
          Wanderly is a personal demo with a fictional brand. AI answers can be wrong: check
          important details before you travel.
        </p>
      </div>
    </footer>
  );
}
