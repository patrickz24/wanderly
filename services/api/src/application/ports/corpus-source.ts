import type { Facts } from '@wanderly/contracts';

/**
 * Port: where the destination corpus is read from (the `data/corpus` directory in practice).
 * Adapters validate every file with the shared Zod schemas before returning it.
 */

export type DocumentRole = 'region' | 'place';

export interface CorpusDocument {
  /** POSIX path relative to the corpus root, e.g. "sicily/guide.md" or "sicily/places/palermo.md". */
  readonly path: string;
  readonly destinationId: string;
  readonly role: DocumentRole;
  /** Title of the document itself ("Sicily", "Palermo"). */
  readonly title: string;
  /**
   * Root of the chunk breadcrumbs: the destination name for its region guide, and
   * "<destination> > <place>" for a place article, so a place chunk still names its region.
   */
  readonly breadcrumbRoot: string;
  /** Permanent link to the source revision. */
  readonly sourceUrl: string;
  readonly license: string;
  readonly attribution: string;
  /** Markdown body, front matter removed. */
  readonly body: string;
  /** SHA-256 (hex) of the raw file: the document is re-indexed only when it changes. */
  readonly checksum: string;
}

export interface CorpusDestination {
  readonly facts: Facts;
  /** Date (YYYY-MM-DD) of the guide revision the facts (prices) were read from. */
  readonly factsAsOf: string;
  /** Region guide first, then place articles. */
  readonly documents: readonly CorpusDocument[];
}

export interface Corpus {
  readonly destinations: readonly CorpusDestination[];
}

export interface CorpusSource {
  load(): Promise<Corpus>;
}

/** The corpus is invalid: nothing is ingested. Lists every problem found, file by file. */
export class CorpusValidationError extends Error {
  constructor(readonly issues: readonly string[]) {
    super(['Invalid corpus:', ...issues.map((issue) => `  - ${issue}`)].join('\n'));
    this.name = 'CorpusValidationError';
  }
}
