import pgvector from 'pgvector';
import type pg from 'pg';
import type {
  Embedder,
  RetrievalQuery,
  RetrievedChunk,
  Retriever,
} from '../../domain/ports/knowledge.js';
import { DEFAULT_RRF_K, reciprocalRankFusion } from '../../domain/rag/rrf.js';
import { toWebSearchQuery, type FullTextMatch } from './full-text-query.js';
import { withTransaction, type PgPool } from './sql.js';

export type RetrievalStrategy = 'hybrid' | 'vector' | 'fulltext';

export interface PgRetrieverOptions {
  /** `hybrid` in production; the single-list strategies exist for the evaluation. */
  readonly strategy?: RetrievalStrategy;
  /** Candidates taken from each list before fusion (at least the requested limit). */
  readonly candidates?: number;
  readonly rrfK?: number;
  readonly fullTextMatch?: FullTextMatch;
  /** HNSW search breadth (`hnsw.ef_search`); must be >= the candidates to return them all. */
  readonly efSearch?: number;
}

/** A retrieved chunk plus what the evaluation needs to match it against section labels. */
export interface RetrievedChunkDetails extends RetrievedChunk {
  /** Path of the source document relative to the corpus root, e.g. "sicily/guide.md". */
  readonly documentPath: string;
  /** Sections covered by the chunk, relative to its document ("Do > Hiking"). */
  readonly sections: readonly string[];
}

export const MAX_RETRIEVAL_LIMIT = 50;

const DEFAULTS = {
  strategy: 'hybrid',
  candidates: 20,
  rrfK: DEFAULT_RRF_K,
  fullTextMatch: 'any',
  efSearch: 100,
} as const satisfies Required<PgRetrieverOptions>;

interface ChunkRow {
  id: string;
  destination_id: string;
  heading_path: string;
  section_paths: string[];
  content: string;
  title: string;
  source_url: string | null;
  source_path: string;
}

/**
 * Hybrid retrieval over Postgres: a vector top-N (cosine distance `<=>` on the HNSW index) and a
 * full-text top-N (`websearch_to_tsquery('english')`, `ts_rank_cd`), fused with Reciprocal Rank
 * Fusion in the domain. Both lists are read in one REPEATABLE READ, READ ONLY transaction, so a
 * concurrent re-ingestion cannot remove a chunk between the searches and the final read.
 *
 * With a destination filter, the HNSW scan uses pgvector's iterative scan (`strict_order`):
 * without it, the index returns its `ef_search` nearest chunks of ALL destinations first and the
 * filter then keeps only a few of them, silently returning fewer results than asked.
 */
export class PgRetriever implements Retriever {
  readonly #options: Required<PgRetrieverOptions>;

  constructor(
    private readonly pool: PgPool,
    private readonly embedder: Embedder,
    options: PgRetrieverOptions = {},
  ) {
    this.#options = { ...DEFAULTS, ...options };
  }

  async search(query: RetrievalQuery): Promise<readonly RetrievedChunk[]> {
    const details = await this.searchDetailed(query);
    return details.map((chunk) => ({
      id: chunk.id,
      destinationId: chunk.destinationId,
      documentTitle: chunk.documentTitle,
      headingPath: chunk.headingPath,
      content: chunk.content,
      sourceUrl: chunk.sourceUrl,
      score: chunk.score,
      ranks: chunk.ranks,
    }));
  }

  async searchDetailed(
    query: RetrievalQuery,
    overrides: PgRetrieverOptions = {},
  ): Promise<RetrievedChunkDetails[]> {
    const options = { ...this.#options, ...overrides };
    if (!Number.isInteger(query.limit) || query.limit < 1 || query.limit > MAX_RETRIEVAL_LIMIT) {
      throw new RangeError(`limit must be an integer between 1 and ${MAX_RETRIEVAL_LIMIT}`);
    }
    const text = query.text.trim();
    if (text === '') return [];
    const candidates = Math.max(options.candidates, query.limit);
    const useVector = options.strategy !== 'fulltext';
    const useFullText = options.strategy !== 'vector';

    // Embed before opening the transaction: the model is the slow part.
    const [queryVector] = useVector ? await this.embedder.embed([text], 'query') : [];

    return withTransaction(
      this.pool,
      async (client) => {
        const vectorIds =
          queryVector === undefined
            ? []
            : await vectorSearch(client, queryVector, query.destinationId, candidates, options);
        const fullTextIds = useFullText
          ? await fullTextSearch(
              client,
              toWebSearchQuery(text, options.fullTextMatch),
              query.destinationId,
              candidates,
            )
          : [];

        const fused = reciprocalRankFusion(
          { vector: vectorIds, fullText: fullTextIds },
          { k: options.rrfK, limit: query.limit },
        );
        const rows = await readChunks(
          client,
          fused.map((result) => result.id),
        );
        return fused.flatMap((result) => {
          const row = rows.get(result.id);
          return row === undefined ? [] : [toDetails(row, result.score, result.ranks)];
        });
      },
      'BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY',
    );
  }
}

async function vectorSearch(
  client: pg.PoolClient,
  vector: readonly number[],
  destinationId: string | null,
  limit: number,
  options: Required<PgRetrieverOptions>,
): Promise<string[]> {
  await client.query(`SELECT set_config('hnsw.ef_search', $1, true)`, [
    String(Math.max(options.efSearch, limit)),
  ]);
  const literal = pgvector.toSql([...vector]);
  if (destinationId === null) {
    const { rows } = await client.query<{ id: string }>(
      `SELECT id FROM chunks ORDER BY embedding <=> $1::vector LIMIT $2`,
      [literal, limit],
    );
    return rows.map((row) => row.id);
  }
  await client.query(`SELECT set_config('hnsw.iterative_scan', 'strict_order', true)`);
  const { rows } = await client.query<{ id: string }>(
    `SELECT id FROM chunks WHERE destination_id = $2
     ORDER BY embedding <=> $1::vector LIMIT $3`,
    [literal, destinationId, limit],
  );
  return rows.map((row) => row.id);
}

async function fullTextSearch(
  client: pg.PoolClient,
  webSearchQuery: string,
  destinationId: string | null,
  limit: number,
): Promise<string[]> {
  if (webSearchQuery.trim() === '') return [];
  // Ties on rank are ordered by id so that the list is deterministic.
  const { rows } = await client.query<{ id: string }>(
    `SELECT c.id
     FROM chunks c, websearch_to_tsquery('english', $1) AS q
     WHERE c.tsv @@ q AND ($2::text IS NULL OR c.destination_id = $2::text)
     ORDER BY ts_rank_cd(c.tsv, q) DESC, c.id
     LIMIT $3`,
    [webSearchQuery, destinationId, limit],
  );
  return rows.map((row) => row.id);
}

async function readChunks(
  client: pg.PoolClient,
  ids: readonly string[],
): Promise<Map<string, ChunkRow>> {
  if (ids.length === 0) return new Map();
  const { rows } = await client.query<ChunkRow>(
    `SELECT c.id, c.destination_id, c.heading_path, c.section_paths, c.content,
            d.title, d.source_url, d.source_path
     FROM chunks c JOIN documents d ON d.id = c.document_id
     WHERE c.id = ANY($1::uuid[])`,
    [[...ids]],
  );
  return new Map(rows.map((row) => [row.id, row]));
}

function toDetails(
  row: ChunkRow,
  score: number,
  ranks: { readonly vector: number | null; readonly fullText: number | null },
): RetrievedChunkDetails {
  return {
    id: row.id,
    destinationId: row.destination_id,
    documentTitle: row.title,
    headingPath: row.heading_path,
    content: row.content,
    sourceUrl: row.source_url ?? '',
    score,
    ranks: { vector: ranks.vector, fullText: ranks.fullText },
    documentPath: row.source_path,
    sections: row.section_paths,
  };
}
