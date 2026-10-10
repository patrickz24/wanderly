import type { CostFigure, CostLevel, Facts } from '@wanderly/contracts';
import pgvector from 'pgvector';
import type pg from 'pg';
import type { CorpusDestination } from '../../application/ports/corpus-source.js';
import type {
  DestinationSyncResult,
  DocumentToStore,
  IndexedDocument,
  KnowledgeStore,
} from '../../application/ports/knowledge-store.js';
import { insertRows, withTransaction, type PgPool } from './sql.js';

const COST_LEVELS = ['overall', 'budget', 'mid', 'comfort'] as const;

/** Write side of the knowledge base over Postgres + pgvector (used by the ingestion). */
export class PgKnowledgeStore implements KnowledgeStore {
  constructor(private readonly pool: PgPool) {}

  async syncDestinations(
    destinations: readonly CorpusDestination[],
  ): Promise<DestinationSyncResult> {
    return withTransaction(this.pool, async (client) => {
      for (const destination of destinations) {
        await upsertDestination(client, destination.facts);
        await replaceFacts(client, destination);
      }
      const { rows } = await client.query<{ id: string }>(
        `DELETE FROM destinations WHERE NOT (id = ANY($1::text[])) RETURNING id`,
        [destinations.map((destination) => destination.facts.id)],
      );
      return {
        upserted: destinations.length,
        removed: rows.map((row) => row.id).sort(),
      };
    });
  }

  async listIndexedDocuments(): Promise<readonly IndexedDocument[]> {
    const { rows } = await this.pool.query<{
      source_path: string;
      checksum: string;
      embedding_model: string | null;
      chunking: string | null;
    }>(
      `SELECT source_path, checksum, embedding_model, chunking FROM documents ORDER BY source_path`,
    );
    return rows.map((row) => ({
      path: row.source_path,
      checksum: row.checksum,
      embeddingModel: row.embedding_model,
      chunking: row.chunking,
    }));
  }

  async replaceDocument({
    document,
    embeddingModel,
    chunking,
    chunks,
  }: DocumentToStore): Promise<void> {
    await withTransaction(this.pool, async (client) => {
      await client.query(`DELETE FROM documents WHERE source_path = $1`, [document.path]);
      const { rows } = await client.query<{ id: string }>(
        `INSERT INTO documents
           (destination_id, source_path, role, title, source_url, license, attribution,
            checksum, embedding_model, chunking)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
         RETURNING id`,
        [
          document.destinationId,
          document.path,
          document.role,
          document.title,
          document.sourceUrl,
          document.license,
          document.attribution,
          document.checksum,
          embeddingModel,
          chunking,
        ],
      );
      const documentId = rows[0]?.id;
      if (documentId === undefined) throw new Error(`could not insert ${document.path}`);
      await insertRows(
        client,
        'chunks',
        [
          'document_id',
          'destination_id',
          'ordinal',
          'heading_path',
          'section_paths',
          'content',
          'token_count',
          'embedding',
        ],
        chunks.map((chunk) => [
          documentId,
          document.destinationId,
          chunk.ordinal,
          chunk.headingPath,
          [...chunk.sections],
          chunk.content,
          chunk.tokenCount,
          pgvector.toSql([...chunk.embedding]),
        ]),
        { embedding: '::vector' },
      );
    });
  }

  async removeDocuments(paths: readonly string[]): Promise<void> {
    await this.pool.query(`DELETE FROM documents WHERE source_path = ANY($1::text[])`, [
      [...paths],
    ]);
  }

  /** Refreshes planner statistics after a bulk load (HNSW and GIN indexes are kept up to date). */
  async analyze(): Promise<void> {
    await this.pool.query('ANALYZE documents, chunks, pois, climate_normals');
  }
}

async function upsertDestination(client: pg.PoolClient, facts: Facts): Promise<void> {
  await client.query(
    `INSERT INTO destinations (id, name, country, region, aliases)
     VALUES ($1, $2, $3, $4, $5)
     ON CONFLICT (id) DO UPDATE
       SET name = EXCLUDED.name, country = EXCLUDED.country,
           region = EXCLUDED.region, aliases = EXCLUDED.aliases`,
    [
      facts.id,
      facts.name,
      facts.country,
      facts.is_part_of.length > 0 ? facts.is_part_of.join(' > ') : null,
      facts.aliases,
    ],
  );
}

/** Climate, costs and POIs are small: they are replaced as a whole on every run. */
async function replaceFacts(client: pg.PoolClient, destination: CorpusDestination): Promise<void> {
  const { facts } = destination;
  const id = facts.id;

  await client.query(`DELETE FROM climate_normals WHERE destination_id = $1`, [id]);
  await insertRows(
    client,
    'climate_normals',
    [
      'destination_id',
      'month',
      'avg_high_c',
      'avg_low_c',
      'rain_days',
      'precipitation_mm',
      'source',
    ],
    facts.climate.months.map((month) => [
      id,
      month.month,
      month.avg_high_c,
      month.avg_low_c,
      month.rain_days,
      month.precipitation_mm,
      facts.climate.attribution,
    ]),
  );

  // Deleting the profiles cascades to their figures.
  await client.query(`DELETE FROM cost_profiles WHERE destination_id = $1`, [id]);
  const levels: Record<(typeof COST_LEVELS)[number], CostLevel> = {
    overall: facts.costs.overall,
    ...facts.costs.levels,
  };
  await insertRows(
    client,
    'cost_profiles',
    ['destination_id', 'level', 'as_of', 'source', 'notes'],
    COST_LEVELS.map((level) => [
      id,
      level,
      destination.factsAsOf,
      facts.costs.derivation,
      levels[level].notes,
    ]),
  );
  const figures = COST_LEVELS.flatMap((level) =>
    (
      [
        ['lodging_night', levels[level].lodging_night],
        ['meal', levels[level].meal],
      ] as const
    ).flatMap(([item, figure]) => (figure === null ? [] : [figureRow(id, level, item, figure)])),
  );
  await insertRows(
    client,
    'cost_figures',
    [
      'destination_id',
      'level',
      'item',
      'median',
      'min',
      'max',
      'currency',
      'sample_size',
      'excluded_other_currency',
    ],
    figures,
  );

  await client.query(`DELETE FROM pois WHERE destination_id = $1`, [id]);
  await insertRows(
    client,
    'pois',
    [
      'id',
      'destination_id',
      'ordinal',
      'name',
      'kinds',
      'crowd_level',
      'best_months',
      'description',
      'source_ref',
    ],
    facts.pois.map((poi, index) => [
      poi.id,
      id,
      index,
      poi.name,
      poi.kinds,
      poi.crowd_level,
      poi.best_months,
      poi.description,
      poi.source_ref,
    ]),
  );
}

function figureRow(
  destinationId: string,
  level: string,
  item: string,
  figure: CostFigure,
): unknown[] {
  return [
    destinationId,
    level,
    item,
    figure.median,
    figure.min,
    figure.max,
    figure.currency,
    figure.sample_size,
    figure.excluded_other_currency,
  ];
}
