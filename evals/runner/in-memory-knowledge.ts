import type { CostFigure as CorpusCostFigure, CostLevel, Facts } from '@wanderly/contracts';
import type { Corpus } from '../../services/api/src/application/ports/corpus-source.js';
import { DEFAULT_CHUNKING, markdownChunker } from '../../services/api/src/domain/rag/chunker.js';
import type {
  ClimateMonthFact,
  CostFacts,
  CostFigure,
  CostLevelFact,
  DestinationSummary,
  KnowledgeRepository,
  PoiFact,
  PoiQuery,
  RetrievalQuery,
  RetrievedChunk,
  Retriever,
} from '../../services/api/src/domain/ports/knowledge.js';

/**
 * In-memory knowledge ports built from the real corpus files, for the keyless HARNESS CHECKS only
 * (oracle and null-baseline runs in CI, without Postgres or the embedding model). Real agent
 * evaluations use the production `PgKnowledgeRepository` and `PgRetriever` on an ingested
 * database; nothing here is used to measure the agent.
 *
 * The retriever is a plain keyword-overlap ranking over the production chunker's output: enough
 * to return real, citable excerpts of the right destination, not a retrieval benchmark.
 */
export class InMemoryKnowledge implements KnowledgeRepository {
  readonly #facts: ReadonlyMap<string, Facts>;

  constructor(corpus: Corpus) {
    this.#facts = new Map(corpus.destinations.map((d) => [d.facts.id, d.facts]));
  }

  async listDestinations(): Promise<readonly DestinationSummary[]> {
    return [...this.#facts.values()]
      .map((facts) => ({
        id: facts.id,
        name: facts.name,
        country: facts.country,
        aliases: facts.aliases,
      }))
      .sort((left, right) => left.id.localeCompare(right.id));
  }

  async getClimate(destinationId: string, month: number): Promise<ClimateMonthFact | null> {
    const facts = this.#facts.get(destinationId);
    const normal = facts?.climate.months.find((entry) => entry.month === month);
    if (facts === undefined || normal === undefined) return null;
    return {
      destinationId,
      month,
      avgHighC: normal.avg_high_c,
      avgLowC: normal.avg_low_c,
      rainDays: normal.rain_days,
      precipitationMm: normal.precipitation_mm,
      attribution: facts.climate.attribution,
    };
  }

  async getCosts(destinationId: string): Promise<CostFacts | null> {
    const facts = this.#facts.get(destinationId);
    if (facts === undefined) return null;
    const { costs } = facts;
    return {
      destinationId,
      derivation: costs.derivation,
      overall: toLevel(costs.overall),
      levels: {
        budget: toLevel(costs.levels.budget),
        mid: toLevel(costs.levels.mid),
        comfort: toLevel(costs.levels.comfort),
      },
    };
  }

  async searchPois(query: PoiQuery): Promise<readonly PoiFact[]> {
    const facts = this.#facts.get(query.destinationId);
    if (facts === undefined) return [];
    return facts.pois
      .filter((poi) => query.kinds.length === 0 || poi.kinds.some((k) => query.kinds.includes(k)))
      .filter(
        (poi) =>
          query.maxCrowdLevel === null ||
          poi.crowd_level === null ||
          poi.crowd_level <= query.maxCrowdLevel,
      )
      .map((poi) => ({
        id: poi.id,
        destinationId: facts.id,
        name: poi.name,
        kinds: poi.kinds,
        description: poi.description,
        crowdLevel: poi.crowd_level,
        bestMonths: poi.best_months,
        sourceRef: poi.source_ref,
      }))
      .sort((left, right) => seasonal(right, query.month) - seasonal(left, query.month))
      .slice(0, query.limit);
  }
}

function seasonal(poi: PoiFact, month: number | null): number {
  return month !== null && poi.bestMonths.includes(month) ? 1 : 0;
}

function toLevel(level: CostLevel): CostLevelFact {
  return {
    lodgingNight: toFigure(level.lodging_night),
    meal: toFigure(level.meal),
    notes: level.notes,
  };
}

function toFigure(figure: CorpusCostFigure | null): CostFigure | null {
  if (figure === null) return null;
  return {
    median: figure.median,
    min: figure.min,
    max: figure.max,
    currency: figure.currency,
    sampleSize: figure.sample_size,
  };
}

interface IndexedChunk {
  readonly chunk: RetrievedChunk;
  readonly words: ReadonlySet<string>;
}

export class KeywordRetriever implements Retriever {
  readonly #chunks: readonly IndexedChunk[];

  constructor(corpus: Corpus) {
    const chunker = markdownChunker(DEFAULT_CHUNKING);
    this.#chunks = corpus.destinations.flatMap((destination) =>
      destination.documents.flatMap((document) =>
        chunker.chunk({ title: document.breadcrumbRoot, markdown: document.body }).map((chunk) => ({
          words: new Set(words(chunk.text)),
          chunk: {
            id: `${document.path}#${chunk.ordinal}`,
            destinationId: document.destinationId,
            documentTitle: document.title,
            headingPath: chunk.headingPath,
            content: chunk.content,
            sourceUrl: document.sourceUrl,
            score: 0,
            ranks: { vector: null, fullText: null },
          },
        })),
      ),
    );
  }

  async search(query: RetrievalQuery): Promise<readonly RetrievedChunk[]> {
    const terms = [...new Set(words(query.text))];
    return this.#chunks
      .filter(
        ({ chunk }) => query.destinationId === null || chunk.destinationId === query.destinationId,
      )
      .map(({ chunk, words: present }) => ({
        chunk,
        score: terms.filter((term) => present.has(term)).length,
      }))
      .filter(({ score }) => score > 0)
      .sort(
        (left, right) => right.score - left.score || left.chunk.id.localeCompare(right.chunk.id),
      )
      .slice(0, query.limit)
      .map(({ chunk, score }, index) => ({
        ...chunk,
        score,
        ranks: { vector: null, fullText: index + 1 },
      }));
  }
}

function words(text: string): string[] {
  return text
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((word) => word.length > 2);
}
