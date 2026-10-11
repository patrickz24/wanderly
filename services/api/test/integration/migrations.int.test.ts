import type pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { listMigrationNames } from '../../src/infrastructure/db/migration-files.js';
import { createScratchDatabase, migrate, withClient, type ScratchDatabase } from './db.js';

const TABLES = [
  'agent_runs',
  'chunks',
  'climate_normals',
  'conversations',
  'cost_figures',
  'cost_profiles',
  'destinations',
  'documents',
  'feedback',
  'messages',
  'pois',
];

/** A unit vector of the embedding size, as pgvector's text literal. */
const vector = (dimensions = 384) => `[${[1, ...Array<number>(dimensions - 1).fill(0)].join(',')}]`;

let scratch: ScratchDatabase;

beforeAll(async () => {
  scratch = await createScratchDatabase();
});

afterAll(async () => {
  await scratch?.drop();
});

async function publicTables(client: pg.Client): Promise<string[]> {
  const { rows } = await client.query<{ table_name: string }>(
    `SELECT table_name FROM information_schema.tables
     WHERE table_schema = 'public' AND table_type = 'BASE TABLE' ORDER BY table_name`,
  );
  return rows.map((row) => row.table_name);
}

/** Runs `work` in a transaction that is always rolled back. */
function inRollback(work: (client: pg.Client) => Promise<void>): Promise<void> {
  return withClient(scratch.url, async (client) => {
    await client.query('BEGIN');
    try {
      await work(client);
    } finally {
      await client.query('ROLLBACK');
    }
  });
}

/** Asserts that a statement fails with the given SQLSTATE, without aborting the transaction. */
async function expectSqlState(
  client: pg.Client,
  sqlState: string,
  text: string,
  values: unknown[] = [],
): Promise<void> {
  await client.query('SAVEPOINT expect_failure');
  try {
    await expect(client.query(text, values)).rejects.toMatchObject({ code: sqlState });
  } finally {
    await client.query('ROLLBACK TO SAVEPOINT expect_failure');
  }
}

async function seedKnowledge(client: pg.Client): Promise<{ documentId: string }> {
  await client.query(
    `INSERT INTO destinations (id, name, country, aliases) VALUES
       ('sicily', 'Sicily', 'Italy', '{Sicilia}'),
       ('malta', 'Malta', 'Malta', '{}')`,
  );
  const { rows } = await client.query<{ id: string }>(
    `INSERT INTO documents (destination_id, source_path, title, license, checksum)
     VALUES ('sicily', 'data/corpus/sicily/guide.md', 'Sicily guide', 'CC BY-SA 4.0', 'abc123')
     RETURNING id`,
  );
  const documentId = rows[0]!.id;
  await client.query(
    `INSERT INTO chunks (document_id, destination_id, ordinal, heading_path, content, token_count, embedding)
     VALUES ($1, 'sicily', 0, 'Sicily > Do > Hiking', 'Mount Etna offers volcanic hikes.', 9, $2)`,
    [documentId, vector()],
  );
  return { documentId };
}

async function seedConversation(client: pg.Client): Promise<{ conversationId: string }> {
  const { rows } = await client.query<{ id: string }>(
    `INSERT INTO conversations (session_id) VALUES ('session-abc') RETURNING id`,
  );
  const conversationId = rows[0]!.id;
  await client.query(
    `INSERT INTO messages (conversation_id, seq, role, content, provider, model) VALUES
       ($1, 0, 'user', '[{"type":"text","text":"Sicily in May?"}]', NULL, NULL),
       ($1, 1, 'assistant', '[{"type":"text","text":"Sure."}]', 'anthropic', 'claude-haiku-5-5')`,
    [conversationId],
  );
  const run = await client.query<{ id: string }>(
    `INSERT INTO agent_runs (conversation_id, model, status, response_type, steps, tool_calls, cost_usd)
     VALUES ($1, 'claude-haiku-5-5', 'ok', 'answer', 2, 1, 0.000420) RETURNING id`,
    [conversationId],
  );
  await client.query(`INSERT INTO feedback (run_id, rating) VALUES ($1, 1)`, [run.rows[0]!.id]);
  return { conversationId };
}

describe('SQL migrations on a fresh pgvector database', () => {
  it('apply every migration file, in order', async () => {
    const shipped = await listMigrationNames();

    const applied = await migrate(scratch.url, 'up');

    expect(applied).toEqual(shipped);
    await withClient(scratch.url, async (client) => {
      const { rows } = await client.query<{ name: string }>(
        'SELECT name FROM pgmigrations ORDER BY run_on, id',
      );
      expect(rows.map((row) => row.name)).toEqual(shipped);
    });
  });

  it('install pgvector and create every table of the data model', async () => {
    await withClient(scratch.url, async (client) => {
      const extension = await client.query(`SELECT 1 FROM pg_extension WHERE extname = 'vector'`);
      expect(extension.rowCount).toBe(1);
      expect(await publicTables(client)).toEqual([...TABLES, 'pgmigrations'].sort());
    });
  });

  it('index chunks for vector, full-text and per-destination search', async () => {
    await withClient(scratch.url, async (client) => {
      const { rows } = await client.query<{ indexdef: string }>(
        `SELECT indexdef FROM pg_indexes WHERE tablename = 'chunks'`,
      );
      const definitions = rows.map((row) => row.indexdef).join('\n');
      expect(definitions).toMatch(/USING hnsw \(embedding vector_cosine_ops\)/);
      expect(definitions).toMatch(/USING gin \(tsv\)/);
      expect(definitions).toMatch(/USING btree \(destination_id\)/);
    });
  });

  it('generate the English tsvector from heading path and content', async () => {
    await inRollback(async (client) => {
      await seedKnowledge(client);
      const { rows } = await client.query<{ matches: boolean; distance: number }>(
        `SELECT tsv @@ websearch_to_tsquery('english', 'etna hiking') AS matches,
                embedding <=> $1 AS distance
         FROM chunks`,
        [vector()],
      );
      expect(rows).toEqual([{ matches: true, distance: 0 }]);
    });
  });

  it('enforce embedding size and chunk/document destination consistency', async () => {
    await inRollback(async (client) => {
      const { documentId } = await seedKnowledge(client);
      const insertChunk = `INSERT INTO chunks
        (document_id, destination_id, ordinal, content, token_count, embedding)
        VALUES ($1, $2, $3, 'Valletta is compact.', 4, $4)`;

      await expectSqlState(client, '22000', insertChunk, [documentId, 'sicily', 1, vector(3)]);
      await expectSqlState(client, '23503', insertChunk, [documentId, 'malta', 1, vector()]);
      await expectSqlState(client, '23505', insertChunk, [documentId, 'sicily', 0, vector()]);
      await expectSqlState(client, '23502', insertChunk, [documentId, 'sicily', 1, null]);
    });
  });

  it('reject out-of-range reference data', async () => {
    await inRollback(async (client) => {
      await seedKnowledge(client);
      const checkViolation = '23514';
      await expectSqlState(
        client,
        checkViolation,
        `INSERT INTO climate_normals
           (destination_id, month, avg_high_c, avg_low_c, rain_days, precipitation_mm, source)
         VALUES ('sicily', 13, 20, 10, 5, 40, 'open-meteo')`,
      );
      await expectSqlState(
        client,
        checkViolation,
        `INSERT INTO climate_normals
           (destination_id, month, avg_high_c, avg_low_c, rain_days, precipitation_mm, source)
         VALUES ('sicily', 5, 10, 20, 5, 40, 'open-meteo')`,
      );
      await expectSqlState(
        client,
        checkViolation,
        `INSERT INTO cost_profiles (destination_id, level, as_of, source)
         VALUES ('sicily', 'luxury', '2026-01-01', 'corpus')`,
      );
      await expectSqlState(
        client,
        checkViolation,
        `INSERT INTO pois (id, destination_id, name, crowd_level) VALUES ('etna', 'sicily', 'Etna', 6)`,
      );
      await expectSqlState(
        client,
        checkViolation,
        `INSERT INTO pois (id, destination_id, name, best_months) VALUES ('etna', 'sicily', 'Etna', '{0,5}')`,
      );
      await expectSqlState(
        client,
        checkViolation,
        `INSERT INTO destinations (id, name, country) VALUES ('Not A Slug', 'X', 'Y')`,
      );

      // Unknown values are allowed where the corpus may lack data.
      await client.query(
        `INSERT INTO cost_profiles (destination_id, level, as_of, source)
         VALUES ('sicily', 'mid', '2026-01-01', 'corpus')`,
      );
      await client.query(
        `INSERT INTO pois (id, destination_id, name, best_months) VALUES ('mount-etna', 'sicily', 'Etna', '{4,5,9,10}')`,
      );
    });
  });

  it('keep the transcript append-only and unique per sequence number', async () => {
    await inRollback(async (client) => {
      const { conversationId } = await seedConversation(client);

      await expectSqlState(
        client,
        'P0001',
        `UPDATE messages SET content = '[]' WHERE conversation_id = $1 AND seq = 0`,
        [conversationId],
      );
      await expectSqlState(
        client,
        '23505',
        `INSERT INTO messages (conversation_id, seq, role, content) VALUES ($1, 1, 'user', '[]')`,
        [conversationId],
      );
      await expectSqlState(
        client,
        '23514',
        `INSERT INTO messages (conversation_id, seq, role, content) VALUES ($1, 2, 'assistant', '[]')`,
        [conversationId],
      );
      await expectSqlState(
        client,
        '23514',
        `INSERT INTO messages (conversation_id, seq, role, content) VALUES ($1, 2, 'user', '{}')`,
        [conversationId],
      );
    });
  });

  it('keep agent run accounting consistent', async () => {
    await inRollback(async (client) => {
      const { conversationId } = await seedConversation(client);
      const insertRun = `INSERT INTO agent_runs
        (conversation_id, model, status, response_type, error_code, tool_calls, tool_errors, cost_usd)
        VALUES ($1, 'claude-haiku-5-5', $2, $3, $4, $5, $6, $7)`;

      await expectSqlState(client, '23514', insertRun, [
        conversationId,
        'ok',
        'answer',
        'LLM_TIMEOUT',
        0,
        0,
        0,
      ]);
      await expectSqlState(client, '23514', insertRun, [
        conversationId,
        'error',
        null,
        null,
        0,
        0,
        0,
      ]);
      await expectSqlState(client, '23514', insertRun, [
        conversationId,
        'ok',
        'answer',
        null,
        1,
        2,
        0,
      ]);
      await expectSqlState(client, '23514', insertRun, [
        conversationId,
        'ok',
        'answer',
        null,
        0,
        0,
        -1,
      ]);
      await expectSqlState(client, '23514', insertRun, [
        conversationId,
        'error',
        null,
        'TEAPOT',
        0,
        0,
        0,
      ]);
      await client.query(insertRun, [
        conversationId,
        'error',
        null,
        'PROVIDER_UNAVAILABLE',
        0,
        0,
        0,
      ]);

      await expectSqlState(
        client,
        '23514',
        `INSERT INTO feedback (run_id, rating)
         SELECT id, 0 FROM agent_runs WHERE status = 'error' LIMIT 1`,
      );

      // The prompt version is optional (older runs) and bounded to a short identifier.
      await client.query(`UPDATE agent_runs SET prompt_version = 'agent-v1-0123456789ab'`);
      await expectSqlState(
        client,
        '23514',
        `UPDATE agent_runs SET prompt_version = 'agent v1; DROP TABLE agent_runs'`,
      );
    });
  });

  it('delete everything a conversation owns along with it', async () => {
    await inRollback(async (client) => {
      const { conversationId } = await seedConversation(client);

      await client.query('DELETE FROM conversations WHERE id = $1', [conversationId]);

      const { rows } = await client.query<{ messages: number; runs: number; feedback: number }>(
        `SELECT (SELECT count(*)::int FROM messages) AS messages,
                (SELECT count(*)::int FROM agent_runs) AS runs,
                (SELECT count(*)::int FROM feedback) AS feedback`,
      );
      expect(rows[0]).toEqual({ messages: 0, runs: 0, feedback: 0 });
    });
  });

  it('roll back completely and apply again', async () => {
    const shipped = await listMigrationNames();

    expect(await migrate(scratch.url, 'down')).toEqual([...shipped].reverse());
    await withClient(scratch.url, async (client) => {
      expect(await publicTables(client)).toEqual(['pgmigrations']);
    });

    expect(await migrate(scratch.url, 'up')).toEqual(shipped);
    await withClient(scratch.url, async (client) => {
      expect(await publicTables(client)).toEqual([...TABLES, 'pgmigrations'].sort());
    });
  });
});
