import type { DestinationSummary } from '../ports/knowledge.js';

/**
 * The destinations the corpus covers, in a deterministic order (by id, aliases sorted).
 *
 * Determinism matters: the catalog is rendered into the cached system prompt, and the provider
 * rejects (or silently re-processes) a conversation whose prompt prefix changed between turns.
 */
export interface DestinationCatalog {
  readonly entries: readonly DestinationSummary[];
  has(id: string): boolean;
  get(id: string): DestinationSummary | undefined;
}

export function createCatalog(destinations: readonly DestinationSummary[]): DestinationCatalog {
  const entries = Object.freeze(
    [...destinations]
      .sort((a, b) => compare(a.id, b.id))
      .map((destination) =>
        Object.freeze({
          id: destination.id,
          name: destination.name,
          country: destination.country,
          aliases: Object.freeze([...destination.aliases].sort(compare)),
        }),
      ),
  );
  const byId = new Map(entries.map((entry) => [entry.id, entry]));
  return Object.freeze({
    entries,
    has: (id: string) => byId.has(id),
    get: (id: string) => byId.get(id),
  });
}

/** Locale-independent ordering, so the rendered prompt is identical on every host. */
function compare(a: string, b: string): number {
  if (a === b) return 0;
  return a < b ? -1 : 1;
}
