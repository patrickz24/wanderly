-- Up Migration

-- Initial schema (plan section 4): the knowledge base filled by ingestion,
-- then conversations and agent runs. All timestamps are timestamptz (UTC).

CREATE EXTENSION IF NOT EXISTS vector;

-- ---------------------------------------------------------------------------
-- Knowledge base. Rebuildable from data/corpus, so derived rows cascade when
-- their destination or document is deleted (re-ingestion).
-- ---------------------------------------------------------------------------

CREATE TABLE destinations (
  id       text PRIMARY KEY CHECK (id ~ '^[a-z0-9]+(-[a-z0-9]+)*$'),
  name     text NOT NULL CHECK (btrim(name) <> ''),
  country  text NOT NULL CHECK (btrim(country) <> ''),
  region   text,
  aliases  text[] NOT NULL DEFAULT '{}',
  summary  text
);

CREATE TABLE documents (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  destination_id  text NOT NULL REFERENCES destinations (id) ON DELETE CASCADE,
  source_path     text NOT NULL UNIQUE CHECK (btrim(source_path) <> ''),
  title           text NOT NULL CHECK (btrim(title) <> ''),
  source_url      text CHECK (source_url ~ '^https?://'),
  license         text NOT NULL CHECK (btrim(license) <> ''),
  checksum        text NOT NULL CHECK (btrim(checksum) <> ''),
  ingested_at     timestamptz NOT NULL DEFAULT now(),
  -- Target of the composite foreign key from chunks.
  UNIQUE (id, destination_id)
);

CREATE TABLE chunks (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  document_id     uuid NOT NULL,
  -- Denormalized for filtered retrieval; the composite FK keeps it equal to the document's.
  destination_id  text NOT NULL,
  ordinal         integer NOT NULL CHECK (ordinal >= 0),
  heading_path    text NOT NULL DEFAULT '',
  content         text NOT NULL CHECK (btrim(content) <> ''),
  token_count     integer NOT NULL CHECK (token_count > 0),
  -- bge-small-en-v1.5 embeddings. A chunk without a vector would silently drop
  -- out of vector search, so it is required.
  embedding       vector(384) NOT NULL,
  tsv             tsvector GENERATED ALWAYS AS (
                    to_tsvector('english', heading_path || ' ' || content)
                  ) STORED,
  UNIQUE (document_id, ordinal),
  FOREIGN KEY (document_id, destination_id)
    REFERENCES documents (id, destination_id) ON DELETE CASCADE
);

CREATE INDEX chunks_embedding_hnsw_idx ON chunks USING hnsw (embedding vector_cosine_ops);
CREATE INDEX chunks_tsv_gin_idx ON chunks USING gin (tsv);
CREATE INDEX chunks_destination_id_idx ON chunks (destination_id);

CREATE TABLE climate_normals (
  destination_id  text NOT NULL REFERENCES destinations (id) ON DELETE CASCADE,
  month           smallint NOT NULL CHECK (month BETWEEN 1 AND 12),
  avg_high_c      numeric(4, 1) NOT NULL CHECK (avg_high_c BETWEEN -90 AND 60),
  avg_low_c       numeric(4, 1) NOT NULL CHECK (avg_low_c BETWEEN -90 AND 60),
  rain_days       numeric(4, 1) CHECK (rain_days BETWEEN 0 AND 31),
  source          text NOT NULL CHECK (btrim(source) <> ''),
  PRIMARY KEY (destination_id, month),
  CHECK (avg_low_c <= avg_high_c)
);

-- Amounts are per person, in `currency`; any of them may be unknown in the corpus.
CREATE TABLE cost_profiles (
  destination_id  text NOT NULL REFERENCES destinations (id) ON DELETE CASCADE,
  level           text NOT NULL CHECK (level IN ('budget', 'mid', 'comfort')),
  lodging_night   numeric(10, 2) CHECK (lodging_night >= 0),
  food_day        numeric(10, 2) CHECK (food_day >= 0),
  transport_day   numeric(10, 2) CHECK (transport_day >= 0),
  activities_day  numeric(10, 2) CHECK (activities_day >= 0),
  currency        text NOT NULL CHECK (currency ~ '^[A-Z]{3}$'),
  as_of           date NOT NULL,
  source          text NOT NULL CHECK (btrim(source) <> ''),
  PRIMARY KEY (destination_id, level)
);

CREATE TABLE pois (
  id              text PRIMARY KEY CHECK (id ~ '^[a-z0-9]+([._:-][a-z0-9]+)*$'),
  destination_id  text NOT NULL REFERENCES destinations (id) ON DELETE CASCADE,
  name            text NOT NULL CHECK (btrim(name) <> ''),
  kinds           text[] NOT NULL DEFAULT '{}',
  crowd_level     smallint CHECK (crowd_level BETWEEN 1 AND 5),
  best_months     smallint[] NOT NULL DEFAULT '{}'
                  CHECK (best_months <@ '{1,2,3,4,5,6,7,8,9,10,11,12}'::smallint[]),
  description     text,
  source_ref      text
);

CREATE INDEX pois_destination_id_idx ON pois (destination_id);

-- ---------------------------------------------------------------------------
-- Conversations and runs. Everything is owned by a conversation and goes with
-- it (30-day retention purge).
-- ---------------------------------------------------------------------------

CREATE TABLE conversations (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  -- Anonymous session id from the signed cookie.
  session_id  text NOT NULL CHECK (length(session_id) BETWEEN 1 AND 128),
  title       text CHECK (length(title) <= 200),
  -- Structured memory: destination, month, duration, budget, interests…
  trip_brief  jsonb NOT NULL DEFAULT '{}' CHECK (jsonb_typeof(trip_brief) = 'object'),
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now(),
  CHECK (updated_at >= created_at)
);

CREATE INDEX conversations_session_id_updated_at_idx
  ON conversations (session_id, updated_at DESC);
CREATE INDEX conversations_updated_at_idx ON conversations (updated_at);

-- Append-only transcript: raw provider content blocks are replayed verbatim on
-- the next turn (preserved thinking), so a stored message must never change.
CREATE TABLE messages (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  conversation_id  uuid NOT NULL REFERENCES conversations (id) ON DELETE CASCADE,
  seq              integer NOT NULL CHECK (seq >= 0),
  role             text NOT NULL CHECK (role IN ('user', 'assistant', 'tool')),
  content          jsonb NOT NULL CHECK (jsonb_typeof(content) = 'array'),
  provider         text,
  model            text,
  created_at       timestamptz NOT NULL DEFAULT now(),
  UNIQUE (conversation_id, seq),
  CHECK (role <> 'assistant' OR (provider IS NOT NULL AND model IS NOT NULL))
);

CREATE FUNCTION messages_forbid_update() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'messages are append-only (conversation %, seq %)',
    OLD.conversation_id, OLD.seq;
END;
$$;

CREATE TRIGGER messages_append_only
  BEFORE UPDATE ON messages
  FOR EACH ROW EXECUTE FUNCTION messages_forbid_update();

CREATE TABLE agent_runs (
  id                      uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  conversation_id         uuid NOT NULL REFERENCES conversations (id) ON DELETE CASCADE,
  trace_id                text,
  model                   text NOT NULL CHECK (btrim(model) <> ''),
  status                  text NOT NULL CHECK (status IN ('ok', 'error')),
  response_type           text
                          CHECK (response_type IN ('itinerary', 'clarification', 'answer', 'decline')),
  error_code              text CHECK (error_code IN (
                            'VALIDATION_ERROR', 'NOT_FOUND', 'RATE_LIMITED', 'BUDGET_EXCEEDED',
                            'LLM_TIMEOUT', 'PROVIDER_UNAVAILABLE', 'INVALID_OUTPUT', 'INTERNAL_ERROR'
                          )),
  steps                   integer NOT NULL DEFAULT 0 CHECK (steps >= 0),
  tool_calls              integer NOT NULL DEFAULT 0 CHECK (tool_calls >= 0),
  tool_errors             integer NOT NULL DEFAULT 0 CHECK (tool_errors >= 0),
  input_tokens            integer NOT NULL DEFAULT 0 CHECK (input_tokens >= 0),
  output_tokens           integer NOT NULL DEFAULT 0 CHECK (output_tokens >= 0),
  cache_read_tokens       integer NOT NULL DEFAULT 0 CHECK (cache_read_tokens >= 0),
  cost_usd                numeric(10, 6) NOT NULL DEFAULT 0 CHECK (cost_usd >= 0),
  latency_ms              integer CHECK (latency_ms >= 0),
  schema_valid_first_try  boolean,
  citations_ok            boolean,
  created_at              timestamptz NOT NULL DEFAULT now(),
  -- Exactly the failed runs carry an error code; a successful run has a response type.
  CHECK ((status = 'ok') = (error_code IS NULL)),
  CHECK (status = 'error' OR response_type IS NOT NULL),
  CHECK (tool_errors <= tool_calls)
);

-- Daily cost cap: SUM(cost_usd) over today's UTC runs, answered from the index alone.
CREATE INDEX agent_runs_created_at_idx ON agent_runs (created_at) INCLUDE (cost_usd);
CREATE INDEX agent_runs_conversation_id_idx ON agent_runs (conversation_id);

CREATE TABLE feedback (
  run_id      uuid PRIMARY KEY REFERENCES agent_runs (id) ON DELETE CASCADE,
  rating      smallint NOT NULL CHECK (rating IN (-1, 1)),
  comment     text CHECK (length(comment) <= 2000),
  created_at  timestamptz NOT NULL DEFAULT now()
);

-- Down Migration

DROP TABLE IF EXISTS feedback;
DROP TABLE IF EXISTS agent_runs;
DROP TABLE IF EXISTS messages;
DROP FUNCTION IF EXISTS messages_forbid_update();
DROP TABLE IF EXISTS conversations;
DROP TABLE IF EXISTS pois;
DROP TABLE IF EXISTS cost_profiles;
DROP TABLE IF EXISTS climate_normals;
DROP TABLE IF EXISTS chunks;
DROP TABLE IF EXISTS documents;
DROP TABLE IF EXISTS destinations;
-- The vector extension is left in place: it is database-wide and may predate
-- this migration (CREATE EXTENSION IF NOT EXISTS).
