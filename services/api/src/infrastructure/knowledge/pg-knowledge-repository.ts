import type {
  ClimateMonthFact,
  CostFacts,
  CostFigure,
  CostLevelFact,
  CostLevelName,
  DestinationSummary,
  KnowledgeRepository,
  PoiFact,
  PoiQuery,
} from '../../domain/ports/knowledge.js';
import type { PgPool } from './sql.js';

export const MAX_POI_LIMIT = 100;

const LEVEL_NAMES: readonly CostLevelName[] = ['budget', 'mid', 'comfort'];

interface CostRow {
  level: string;
  source: string;
  notes: string[];
  item: 'lodging_night' | 'meal' | null;
  median: number | null;
  min: number | null;
  max: number | null;
  currency: string | null;
  sample_size: number | null;
}

/** Read side of the structured facts (climate, costs, POIs) used by the agent's tools. */
export class PgKnowledgeRepository implements KnowledgeRepository {
  constructor(private readonly pool: PgPool) {}

  async listDestinations(): Promise<readonly DestinationSummary[]> {
    const { rows } = await this.pool.query<DestinationSummary>(
      `SELECT id, name, country, aliases FROM destinations ORDER BY name, id`,
    );
    return rows.map((row) => ({
      id: row.id,
      name: row.name,
      country: row.country,
      aliases: row.aliases,
    }));
  }

  async getClimate(destinationId: string, month: number): Promise<ClimateMonthFact | null> {
    assertMonth(month);
    const { rows } = await this.pool.query<ClimateMonthFact>(
      `SELECT destination_id AS "destinationId", month,
              avg_high_c::float8 AS "avgHighC", avg_low_c::float8 AS "avgLowC",
              rain_days::float8 AS "rainDays", precipitation_mm::float8 AS "precipitationMm",
              source AS attribution
       FROM climate_normals WHERE destination_id = $1 AND month = $2`,
      [destinationId, month],
    );
    return rows[0] ?? null;
  }

  async getCosts(destinationId: string): Promise<CostFacts | null> {
    const { rows } = await this.pool.query<CostRow>(
      `SELECT p.level, p.source, p.notes, f.item,
              f.median::float8 AS median, f.min::float8 AS min, f.max::float8 AS max,
              f.currency, f.sample_size
       FROM cost_profiles p
       LEFT JOIN cost_figures f USING (destination_id, level)
       WHERE p.destination_id = $1
       ORDER BY p.level, f.item`,
      [destinationId],
    );
    const first = rows[0];
    if (first === undefined) return null;

    const levelOf = (name: string): CostLevelFact => {
      const levelRows = rows.filter((row) => row.level === name);
      return {
        lodgingNight: figureOf(levelRows, 'lodging_night'),
        meal: figureOf(levelRows, 'meal'),
        notes: levelRows[0]?.notes ?? [],
      };
    };
    return {
      destinationId,
      derivation: first.source,
      overall: levelOf('overall'),
      levels: Object.fromEntries(LEVEL_NAMES.map((name) => [name, levelOf(name)])) as Record<
        CostLevelName,
        CostLevelFact
      >,
    };
  }

  async searchPois(query: PoiQuery): Promise<readonly PoiFact[]> {
    if (!Number.isInteger(query.limit) || query.limit < 1 || query.limit > MAX_POI_LIMIT) {
      throw new RangeError(`limit must be an integer between 1 and ${MAX_POI_LIMIT}`);
    }
    if (query.month !== null) assertMonth(query.month);
    const crowd = query.maxCrowdLevel;
    if (crowd !== null && (!Number.isInteger(crowd) || crowd < 1 || crowd > 5)) {
      throw new RangeError('maxCrowdLevel must be an integer between 1 and 5');
    }

    // POIs recommended for the month come first, then the corpus order (See before Do).
    const { rows } = await this.pool.query<{
      id: string;
      destination_id: string;
      name: string;
      kinds: string[];
      description: string | null;
      crowd_level: number | null;
      best_months: number[];
      source_ref: string | null;
    }>(
      `SELECT id, destination_id, name, kinds, description, crowd_level, best_months, source_ref
       FROM pois
       WHERE destination_id = $1
         AND (cardinality($2::text[]) = 0 OR kinds && $2::text[])
         AND ($3::smallint IS NULL OR crowd_level IS NULL OR crowd_level <= $3::smallint)
       ORDER BY ($4::smallint IS NOT NULL AND $4::smallint = ANY (best_months)) DESC, ordinal, id
       LIMIT $5`,
      [query.destinationId, [...query.kinds], crowd, query.month, query.limit],
    );
    return rows.map((row) => ({
      id: row.id,
      destinationId: row.destination_id,
      name: row.name,
      kinds: row.kinds,
      description: row.description,
      crowdLevel: row.crowd_level,
      bestMonths: row.best_months,
      sourceRef: row.source_ref ?? '',
    }));
  }
}

function figureOf(rows: readonly CostRow[], item: CostRow['item']): CostFigure | null {
  const row = rows.find((candidate) => candidate.item === item);
  if (
    row === undefined ||
    row.median === null ||
    row.min === null ||
    row.max === null ||
    row.currency === null ||
    row.sample_size === null
  ) {
    return null;
  }
  return {
    median: row.median,
    min: row.min,
    max: row.max,
    currency: row.currency,
    sampleSize: row.sample_size,
  };
}

function assertMonth(month: number): void {
  if (!Number.isInteger(month) || month < 1 || month > 12) {
    throw new RangeError('month must be an integer between 1 and 12');
  }
}
