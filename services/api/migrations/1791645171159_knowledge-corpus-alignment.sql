-- Up Migration

-- Milestone 2: align the knowledge tables with the corpus format (data/README.md, Zod schemas in
-- packages/contracts/src/corpus.ts) and with the knowledge ports of the domain.
--
-- The knowledge base is derived data, rebuilt from data/corpus by the ingestion
-- (`npm run ingest -w @wanderly/api`). No ingestion existed before this migration, so the
-- knowledge tables are empty and NOT NULL columns are added without a default.

-- ---------------------------------------------------------------------------------------------
-- documents: one row per Markdown file, the region guide or a place article.
-- ---------------------------------------------------------------------------------------------

ALTER TABLE documents
  ADD COLUMN role text NOT NULL DEFAULT 'region' CHECK (role IN ('region', 'place')),
  -- CC BY-SA attribution text, shown with the sources.
  ADD COLUMN attribution text CHECK (btrim(attribution) <> ''),
  -- What the chunks were built with: a change of model or chunking re-indexes the document
  -- even when its checksum is unchanged (and tells which rows an embedding migration must redo).
  ADD COLUMN embedding_model text CHECK (btrim(embedding_model) <> ''),
  ADD COLUMN chunking text CHECK (btrim(chunking) <> '');

COMMENT ON COLUMN documents.source_url IS
  'Permanent link to the source revision (attribution and citations).';
COMMENT ON COLUMN documents.checksum IS 'SHA-256 of the source file; unchanged files are skipped.';

-- ---------------------------------------------------------------------------------------------
-- chunks: the sections a chunk covers. Small sibling sections are merged into one chunk whose
-- heading_path is their common parent; retrieval labels are matched against these paths.
-- ---------------------------------------------------------------------------------------------

ALTER TABLE chunks ADD COLUMN section_paths text[] NOT NULL DEFAULT '{}';

-- ---------------------------------------------------------------------------------------------
-- climate_normals: precipitation, and every value required (the corpus always has them).
-- ---------------------------------------------------------------------------------------------

ALTER TABLE climate_normals
  ADD COLUMN precipitation_mm numeric(6, 1) NOT NULL CHECK (precipitation_mm >= 0),
  ALTER COLUMN rain_days SET NOT NULL;

COMMENT ON COLUMN climate_normals.source IS
  'Attribution required by the data licence (CC BY 4.0), shown wherever weather data appears.';

-- ---------------------------------------------------------------------------------------------
-- Costs: the corpus derives price statistics from listing prices (data/README.md, "Costs").
-- A level holds at most a lodging and a meal figure, each with its own currency token as
-- written in the source ("€", "kr"), never converted. Per-day food, transport and activity
-- amounts do not exist in the corpus and are dropped rather than invented.
-- ---------------------------------------------------------------------------------------------

ALTER TABLE cost_profiles DROP CONSTRAINT cost_profiles_level_check;
ALTER TABLE cost_profiles
  ADD CONSTRAINT cost_profiles_level_check
    CHECK (level IN ('overall', 'budget', 'mid', 'comfort')),
  DROP COLUMN lodging_night,
  DROP COLUMN food_day,
  DROP COLUMN transport_day,
  DROP COLUMN activities_day,
  DROP COLUMN currency,
  -- Why a figure is unknown, or caveats about a small sample.
  ADD COLUMN notes text[] NOT NULL DEFAULT '{}';

COMMENT ON COLUMN cost_profiles.as_of IS 'Date of the guide revision the prices were read from.';
COMMENT ON COLUMN cost_profiles.source IS 'How the figures were derived (facts.yaml costs.derivation).';

-- One row per known figure: an unknown figure is an absent row, not a row of NULLs.
CREATE TABLE cost_figures (
  destination_id           text NOT NULL,
  level                    text NOT NULL,
  item                     text NOT NULL CHECK (item IN ('lodging_night', 'meal')),
  median                   numeric NOT NULL CHECK (median >= 0),
  min                      numeric NOT NULL CHECK (min >= 0),
  max                      numeric NOT NULL,
  currency                 text NOT NULL CHECK (btrim(currency) <> ''),
  sample_size              integer NOT NULL CHECK (sample_size > 0),
  excluded_other_currency  integer NOT NULL DEFAULT 0 CHECK (excluded_other_currency >= 0),
  PRIMARY KEY (destination_id, level, item),
  FOREIGN KEY (destination_id, level)
    REFERENCES cost_profiles (destination_id, level) ON DELETE CASCADE,
  CHECK (min <= median AND median <= max)
);

-- ---------------------------------------------------------------------------------------------
-- pois: keep the corpus order (See before Do, listing order) as the default ranking.
-- ---------------------------------------------------------------------------------------------

ALTER TABLE pois ADD COLUMN ordinal integer NOT NULL DEFAULT 0 CHECK (ordinal >= 0);

DROP INDEX pois_destination_id_idx;
CREATE INDEX pois_destination_id_ordinal_idx ON pois (destination_id, ordinal);

-- Down Migration

DROP INDEX IF EXISTS pois_destination_id_ordinal_idx;
CREATE INDEX IF NOT EXISTS pois_destination_id_idx ON pois (destination_id);
ALTER TABLE pois DROP COLUMN IF EXISTS ordinal;

DROP TABLE IF EXISTS cost_figures;
-- Derived data: the previous shape cannot hold the new rows, re-ingest after rolling back.
DELETE FROM cost_profiles;
ALTER TABLE cost_profiles DROP CONSTRAINT cost_profiles_level_check;
ALTER TABLE cost_profiles
  ADD CONSTRAINT cost_profiles_level_check CHECK (level IN ('budget', 'mid', 'comfort')),
  DROP COLUMN notes,
  ADD COLUMN lodging_night numeric(10, 2) CHECK (lodging_night >= 0),
  ADD COLUMN food_day numeric(10, 2) CHECK (food_day >= 0),
  ADD COLUMN transport_day numeric(10, 2) CHECK (transport_day >= 0),
  ADD COLUMN activities_day numeric(10, 2) CHECK (activities_day >= 0),
  ADD COLUMN currency text NOT NULL CHECK (currency ~ '^[A-Z]{3}$');
COMMENT ON COLUMN cost_profiles.as_of IS NULL;
COMMENT ON COLUMN cost_profiles.source IS NULL;

ALTER TABLE climate_normals
  DROP COLUMN precipitation_mm,
  ALTER COLUMN rain_days DROP NOT NULL;
COMMENT ON COLUMN climate_normals.source IS NULL;

ALTER TABLE chunks DROP COLUMN section_paths;

ALTER TABLE documents
  DROP COLUMN chunking,
  DROP COLUMN embedding_model,
  DROP COLUMN attribution,
  DROP COLUMN role;
COMMENT ON COLUMN documents.checksum IS NULL;
COMMENT ON COLUMN documents.source_url IS NULL;
