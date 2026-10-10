-- Up Migration

-- Why a run failed, finer than its error code: LLM_TIMEOUT may be one slow call (llm_timeout)
-- or the whole run's deadline (run_deadline); INVALID_OUTPUT may be a truncation, the step
-- limit or the cost ceiling. The vocabulary belongs to the agent runtime, so it is not
-- enumerated here; it is only bounded.
ALTER TABLE agent_runs
  ADD COLUMN failure_reason text
    CHECK (failure_reason ~ '^[a-z][a-z_]{0,63}$'),
  ADD CONSTRAINT agent_runs_failure_reason_only_on_error
    CHECK (status = 'error' OR failure_reason IS NULL);

-- Down Migration

ALTER TABLE agent_runs
  DROP CONSTRAINT agent_runs_failure_reason_only_on_error,
  DROP COLUMN failure_reason;
