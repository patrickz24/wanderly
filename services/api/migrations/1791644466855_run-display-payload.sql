-- Up Migration

-- Milestone 3: what the conversation API needs to render and account for each run.
--
-- `messages` keeps the raw provider blocks, replayed verbatim to the model on the next turn.
-- The UI must not re-interpret those blocks, so a run also stores its display payload: the
-- validated response, the sources it cites and the tool calls of the transparency panel. A
-- conversation is re-rendered from its completed runs.

ALTER TABLE agent_runs
  -- The user turn and the assistant message (holding the terminal tool call) of the run.
  ADD COLUMN user_message_id       uuid REFERENCES messages (id) ON DELETE CASCADE,
  ADD COLUMN assistant_message_id  uuid REFERENCES messages (id) ON DELETE CASCADE,
  -- What the user typed (the stored user turn may also carry injected context).
  ADD COLUMN user_text             text CHECK (char_length(user_text) <= 4000),
  ADD COLUMN response              jsonb CHECK (jsonb_typeof(response) = 'object'),
  ADD COLUMN sources               jsonb NOT NULL DEFAULT '[]'
                                   CHECK (jsonb_typeof(sources) = 'array'),
  ADD COLUMN tool_call_log         jsonb NOT NULL DEFAULT '[]'
                                   CHECK (jsonb_typeof(tool_call_log) = 'array'),
  ADD COLUMN cache_write_tokens    integer NOT NULL DEFAULT 0 CHECK (cache_write_tokens >= 0),
  ADD COLUMN repairs               integer NOT NULL DEFAULT 0 CHECK (repairs >= 0);

-- Runs abandoned because the client disconnected are recorded as CANCELLED. The code is
-- internal (nobody is listening any more), so it is not part of the public API error codes.
ALTER TABLE agent_runs DROP CONSTRAINT agent_runs_error_code_check;
ALTER TABLE agent_runs ADD CONSTRAINT agent_runs_error_code_check CHECK (error_code IN (
  'VALIDATION_ERROR', 'NOT_FOUND', 'RATE_LIMITED', 'BUDGET_EXCEEDED', 'LLM_TIMEOUT',
  'PROVIDER_UNAVAILABLE', 'INVALID_OUTPUT', 'INTERNAL_ERROR', 'CANCELLED'
));

-- Transcript and turn count: the runs of one conversation in order. Supersedes the
-- single-column index.
DROP INDEX agent_runs_conversation_id_idx;
CREATE INDEX agent_runs_conversation_id_created_at_idx
  ON agent_runs (conversation_id, created_at);

-- Foreign keys to messages: deleting a conversation cascades through messages, which must not
-- scan agent_runs once per message.
CREATE INDEX agent_runs_user_message_id_idx ON agent_runs (user_message_id);
CREATE INDEX agent_runs_assistant_message_id_idx ON agent_runs (assistant_message_id);

-- Down Migration

DROP INDEX IF EXISTS agent_runs_assistant_message_id_idx;
DROP INDEX IF EXISTS agent_runs_user_message_id_idx;
DROP INDEX IF EXISTS agent_runs_conversation_id_created_at_idx;
CREATE INDEX agent_runs_conversation_id_idx ON agent_runs (conversation_id);

UPDATE agent_runs SET error_code = 'INTERNAL_ERROR' WHERE error_code = 'CANCELLED';
ALTER TABLE agent_runs DROP CONSTRAINT agent_runs_error_code_check;
ALTER TABLE agent_runs ADD CONSTRAINT agent_runs_error_code_check CHECK (error_code IN (
  'VALIDATION_ERROR', 'NOT_FOUND', 'RATE_LIMITED', 'BUDGET_EXCEEDED', 'LLM_TIMEOUT',
  'PROVIDER_UNAVAILABLE', 'INVALID_OUTPUT', 'INTERNAL_ERROR'
));

ALTER TABLE agent_runs
  DROP COLUMN repairs,
  DROP COLUMN cache_write_tokens,
  DROP COLUMN tool_call_log,
  DROP COLUMN sources,
  DROP COLUMN response,
  DROP COLUMN user_text,
  DROP COLUMN assistant_message_id,
  DROP COLUMN user_message_id;
