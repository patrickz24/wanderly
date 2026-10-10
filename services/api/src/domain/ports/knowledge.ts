/**
 * Read-only knowledge ports used by the agent's tools. Implemented over Postgres + pgvector by the
 * infrastructure layer; faked in unit tests. Every value comes from the ingested corpus, so the
 * agent can cite it and the grounding checks can verify it.
 */

export interface DestinationSummary {
  readonly id: string;
  readonly name: string;
  readonly country: string;
  readonly aliases: readonly string[];
}

export interface RetrievalQuery {
  /** Search text written by the agent, in English (the corpus language). */
  readonly text: string;
  /** Restrict to one destination when known. */
  readonly destinationId: string | null;
  readonly limit: number;
}

export interface RetrievedChunk {
  readonly id: string;
  readonly destinationId: string;
  /** Title of the source document (destination or city guide). */
  readonly documentTitle: string;
  /** Breadcrumb of headings, e.g. "Sicily > Do > Hiking". */
  readonly headingPath: string;
  readonly content: string;
  /** Public URL of the source revision, for attribution. */
  readonly sourceUrl: string;
  /** Fused score (higher is better). */
  readonly score: number;
  /** 1-based rank in each retriever's list, or null when absent from it (for diagnostics). */
  readonly ranks: { readonly vector: number | null; readonly fullText: number | null };
}

export interface Retriever {
  search(query: RetrievalQuery): Promise<readonly RetrievedChunk[]>;
}

export interface ClimateMonthFact {
  readonly destinationId: string;
  readonly month: number;
  readonly avgHighC: number;
  readonly avgLowC: number;
  readonly rainDays: number;
  readonly precipitationMm: number;
  /** Attribution required by the data licence (shown wherever weather data appears). */
  readonly attribution: string;
}

/** A price statistic derived from listing prices in one currency (never converted). */
export interface CostFigure {
  readonly median: number;
  readonly min: number;
  readonly max: number;
  readonly currency: string;
  readonly sampleSize: number;
}

export type CostLevelName = 'budget' | 'mid' | 'comfort';

export interface CostLevelFact {
  readonly lodgingNight: CostFigure | null;
  readonly meal: CostFigure | null;
  readonly notes: readonly string[];
}

export interface CostFacts {
  readonly destinationId: string;
  readonly derivation: string;
  readonly overall: CostLevelFact;
  readonly levels: Readonly<Record<CostLevelName, CostLevelFact>>;
}

export interface PoiFact {
  readonly id: string;
  readonly destinationId: string;
  readonly name: string;
  readonly kinds: readonly string[];
  readonly description: string | null;
  /** 1 (quiet) … 5 (very crowded); null when the corpus says nothing. */
  readonly crowdLevel: number | null;
  readonly bestMonths: readonly number[];
  /** Heading path of the guide section the POI comes from. */
  readonly sourceRef: string;
}

export interface PoiQuery {
  readonly destinationId: string;
  /** Match any of these kinds; empty = all kinds. */
  readonly kinds: readonly string[];
  /** Exclude POIs known to be more crowded than this; POIs with unknown crowd level are kept. */
  readonly maxCrowdLevel: number | null;
  /** Prefer POIs recommended for this month (ordering, not filtering). */
  readonly month: number | null;
  readonly limit: number;
}

export interface KnowledgeRepository {
  listDestinations(): Promise<readonly DestinationSummary[]>;
  getClimate(destinationId: string, month: number): Promise<ClimateMonthFact | null>;
  getCosts(destinationId: string): Promise<CostFacts | null>;
  searchPois(query: PoiQuery): Promise<readonly PoiFact[]>;
}

export type EmbeddingKind = 'query' | 'document';

/** Text → vectors. Queries and documents may be encoded differently (e.g. instruction prefix). */
export interface Embedder {
  readonly model: string;
  readonly dimensions: number;
  embed(texts: readonly string[], kind: EmbeddingKind): Promise<readonly number[][]>;
}
