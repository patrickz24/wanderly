-- Up Migration

-- The version of the prompt that drove each run (`agent-v1-<hash>`: the system prompt template,
-- the tool specs and the model id, see domain/agent/prompt-version.ts), so a regression found in
-- agent_runs can be tied to a prompt change. Runs recorded before this migration have none.
ALTER TABLE agent_runs
  ADD COLUMN prompt_version text CHECK (prompt_version ~ '^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$');

-- Down Migration

ALTER TABLE agent_runs DROP COLUMN prompt_version;
