# Observability

How Wanderly records what its agent does, which metrics follow from it, and how to diagnose a
regression from those records. Decision record: [ADR 0008](adr/0008-observability-with-langfuse.md).

> [!IMPORTANT]
> **Status.** The tracing code is implemented and tested against an in-memory exporter, and every
> run is recorded in the `agent_runs` table. **No trace has been sent to Langfuse yet**: there are
> no Langfuse keys and no deployment. The Langfuse dashboards and the "real case diagnosed with
> traces" below are **pending** and will be written from the first real traces. Nothing in this
> document describes a trace that did not happen.

## Contents

- [1. What is traced, and why](#1-what-is-traced-and-why)
- [2. Metrics and where to see them](#2-metrics-and-where-to-see-them)
- [3. Diagnosing a regression](#3-diagnosing-a-regression)
- [4. Real case diagnosed with traces](#4-real-case-diagnosed-with-traces)
- [5. Known gaps](#5-known-gaps)

## 1. What is traced, and why

### Two records of every run

| Record                               | Holds                                                                                                                                                                                       | Use it for                                                                                              |
| ------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------- |
| **Langfuse trace** (when configured) | The tree of one run: every model call with its full input and output, every tool call, timings, cost, scores.                                                                               | Understanding _why_ one run behaved as it did.                                                          |
| **`agent_runs` row** (always)        | One row per run: status, error code and finer failure reason, steps, repairs, tool calls and errors, tokens, cost, latency, quality flags, the response, its sources and the tool call log. | Aggregates, the daily cost cap, and finding which runs to open. It is the source of truth for spending. |

Runs that fail, crash or are cancelled by the client are recorded too, with what they spent (the
model port is metered per run). Requests refused before a run starts (rate limit, daily budget,
turn cap, a run already in progress) create neither a trace nor a row: they only appear in the
HTTP logs.

### The `Tracer` port keeps tracing optional

The domain reports what happened through a port (`services/api/src/domain/ports/tracer.ts`),
**after the fact and with explicit timings**: `startRun`, then `llmCall` and `toolCall` records,
`score`, and `end`. Consequences:

- **No vendor in the domain.** `runAgent` only knows the port; the Langfuse SDK lives in
  `src/infrastructure/tracing/langfuse-tracer.ts`.
- **Optional by construction.** The composition root (`src/main.ts`) builds the Langfuse adapter
  only when `LANGFUSE_PUBLIC_KEY` and `LANGFUSE_SECRET_KEY` are both set (configuration refuses one
  without the other); otherwise it injects `NOOP_TRACER`. The startup log line `Langfuse tracing`
  says which, with `enabled: true` or `false`.
- **Tracing never changes a run.** Every adapter operation catches its own errors and logs them as
  `tracing failed`; a broken tracer cannot fail a request.
- **Isolated OpenTelemetry provider.** The adapter creates observations with an explicit parent and
  explicit start and end times in its own tracer provider: no global registration, no
  auto-instrumentation, no reliance on async context. Shutdown flushes buffered spans and scores.
- **Testable.** The mapping is unit-tested with an in-memory span exporter and a fake score sink.

### The mapping

| Langfuse object                              | Created by                               | Contents                                                                                                                                                                                                                                                                                                                                                                                                        |
| -------------------------------------------- | ---------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Trace** `agent-run` (root of type `agent`) | `SendMessage`, one per run               | Input: the user's text. Output: the validated response (null for a failed run). Metadata: run id, model, **prompt version**, status, response type, error code, steps, cost, token usage. **`sessionId` = conversation id**; tags `api` and the environment (`NODE_ENV`); **`version` = the prompt version**, on every observation. `ERROR` level when the run failed.                                          |
| **Generation** `llm-call-<step>`             | `runAgent`, one per model call           | The served model; input = the conversation so far and the tool names (not the system prompt, which holds the canary); output = the content blocks; usage (`input`, `output`, `cache_read_input_tokens`, `cache_creation_input_tokens`); **`costDetails.total` = the cost we computed**; step and stop reason. `ERROR` level with the error (timeout, provider unavailable) when the call failed.                |
| **Tool** `<tool name>`                       | `runAgent`, one per data tool call       | Input: the arguments the model wrote. Output: what the model received (null on failure); for `search_knowledge`, each excerpt also carries its fused RRF `score` and its 1-based `ranks.vector` and `ranks.fullText` (null when absent from a list), which the model never receives. Call id and step. `ERROR` level with the error; when the tool threw, the **internal** message, which the model never sees. |
| **Score** `schema_valid_first_try`           | `SendMessage`, at the end of a run       | 1 when the first terminal call passed validation, 0 when a repair was needed or the run failed with `INVALID_OUTPUT`; absent for other failures.                                                                                                                                                                                                                                                                |
| **Score** `citations_ok`                     | `SendMessage`, successful runs           | 1 when every cited reference resolves to a displayed source. Trivially 1 for clarifications and declines, which cite nothing.                                                                                                                                                                                                                                                                                   |
| **Score** `tool_errors`                      | `SendMessage`, every run                 | Number of failed data tool calls.                                                                                                                                                                                                                                                                                                                                                                               |
| **Score** `repairs`                          | `SendMessage`, runs the runtime returned | Repair rounds used after invalid terminal calls.                                                                                                                                                                                                                                                                                                                                                                |
| **Score** `canary_leak`                      | `SendMessage`, runs the runtime returned | 1 when the canary appeared in a terminal output, which was then replaced by a decline. The offline metric of the same name also looks at outputs that never passed validation ([EVALUATIONS.md](EVALUATIONS.md)).                                                                                                                                                                                               |
| **Score** `provider_refusal`                 | `SendMessage`, runs the runtime returned | 1 when the provider's safety classifiers refused and a decline was returned instead.                                                                                                                                                                                                                                                                                                                            |
| **Score** `injection_signals`                | `SendMessage`, runs the runtime returned | Number of distinct injection heuristics that matched the user text or a tool output; their names (`user:…`, `tool:…`) are in the score comment.                                                                                                                                                                                                                                                                 |
| **Score** `user_feedback`                    | `SubmitFeedback`, later                  | +1 or −1 from the thumbs in the UI, with the optional comment, attached to the past trace through `agent_runs.trace_id`. The `feedback` table stays the source of truth.                                                                                                                                                                                                                                        |

"Runs the runtime returned" excludes crashes: a run whose runtime threw has no repairs or guardrail
signals to report, so those scores are left out rather than set to 0. The evaluation closes its
traces with the same function (`application/run-trace.ts`), so each score means the same thing in
production and in evaluation traces.

Why these choices:

- **One trace per run, session = conversation.** A run is the unit that succeeds or fails; the
  session groups the turns, so Langfuse can show the cost and the replay of a whole conversation.
- **Our cost, not Langfuse's inference.** One price table (`src/infrastructure/llm/pricing.ts`)
  feeds the per-run ceiling, the daily cap, `agent_runs.cost_usd` and the traces, so a dashboard
  and the cap never disagree. If the provider changes its prices, the table must change.
- **Trace attributes on every observation**, not only the root: Langfuse aggregates by session
  only over observations that carry them.
- **The tool output as the model saw it.** Diagnosing a bad answer starts from what the model was
  given, not from what the database holds. Retrieval diagnostics (scores and ranks) are added to
  the trace only, so they cost no prompt tokens.
- **A computed prompt version.** `agent-v1-<12 hex>`: the hand-bumped label of
  `system-prompt.ts` plus a SHA-256 prefix of the system prompt template, every tool spec (names,
  descriptions, the strict schemas generated from the contracts) and the model id
  (`domain/agent/prompt-version.ts`). It changes even when nobody bumps the label. The template is
  rendered with a fixed catalog and a placeholder canary, so the version identifies the code, not
  the ingested corpus, and reveals nothing about the canary. The API computes it once at startup
  and logs it (`agent prompt version`); `agent_runs.prompt_version` stores it with every run.

Privacy: each generation carries the conversation so far, so traces hold the user's messages, tool
results and responses (see [SECURITY.md](../SECURITY.md#data-handling-and-retention)). The
12-turn cap bounds their size.

### Correlation ids

| Id          | Where it appears                                                                                                           |
| ----------- | -------------------------------------------------------------------------------------------------------------------------- |
| `runId`     | `agent_runs.id`, the `run.started` SSE event, the API log line `agent run completed` (or `agent run failed`), signal logs. |
| `traceId`   | `agent_runs.trace_id`, the `run.finished` SSE event, the `agent run completed` log line. Null when tracing is off.         |
| `requestId` | `X-Request-Id` response header, the error envelope, every API log line of the request, nginx (`$request_id`).              |

### Guardrail signals: logged and scored

The guardrails report what they saw in the run result (`signals`); the use case logs them with the
run id and scores them on the trace (`canary_leak`, `provider_refusal`, `injection_signals`).
`agent_runs` does not store them, so without Langfuse keys the logs are their only record:

- `prompt injection signals` (warn), with names such as `user:ignore_instructions` or
  `tool:fake_system_tag`: heuristics on the user's text and on every tool output.
- `system prompt canary found in a model output` (error): the response was replaced by a
  `decline` (`unsafe`).
- `the provider refused to answer` (warn): a `refusal` stop reason, answered with a `decline`.

### Evaluation runs

The agent evaluation always records its own trajectories (every message, tool call and result,
per-call tokens, cost, timing and served model) in `evals/results/<run>/traces/`, next to the
scored rows ([EVALUATIONS.md](EVALUATIONS.md)).

When `LANGFUSE_PUBLIC_KEY` and `LANGFUSE_SECRET_KEY` are set (same rules as the API), it also
traces every turn of every case through the same adapter, so an evaluation case can be compared
with a production trace:

| Field       | Value                                                                                 |
| ----------- | ------------------------------------------------------------------------------------- |
| Environment | `eval`, kept apart from the API's `NODE_ENV` environments                             |
| Tags        | `eval`, `case:<id>`, `category:<category>`, `run:<results folder name>`               |
| Session     | `eval:<results folder>:<case id>:rep<k>`: the turns of one evaluated conversation     |
| Run id      | `<case id>-rep<k>-attempt<n>-turn<t>` in the metadata (a retried attempt has its own) |
| Version     | the prompt version of the evaluated model                                             |
| Scores      | the online scores above; the offline metrics stay in `results.jsonl` and the report   |

Without the keys nothing is sent, which is the case in CI. `summary.json` records the run tag.

## 2. Metrics and where to see them

| Metric                      | Definition                                                                | Langfuse (pending keys)                                       | `agent_runs` |
| --------------------------- | ------------------------------------------------------------------------- | ------------------------------------------------------------- | ------------ |
| Cost per conversation       | Sum of run costs per conversation                                         | Sessions, sorted by cost                                      | Query A      |
| Daily spend against the cap | Sum of `cost_usd` per UTC day, the figure the cap checks                  | Cost over time                                                | Query B      |
| Tool failure rate           | Failed calls / calls, per tool, and tool latency                          | Tool observations at `ERROR` level, score `tool_errors`       | Query C      |
| Latency distribution        | Run latency p50 / p95, steps per run; per model call in Langfuse          | Generation latency by model, trace latency                    | Query D      |
| Repair rate                 | Runs that needed a repair; first-try validity; `INVALID_OUTPUT` by reason | Scores `schema_valid_first_try` and `repairs`                 | Query E      |
| Decline rate                | Share of responses that are declines, by reason                           | Trace metadata `responseType`                                 | Query F      |
| Failures                    | Error code and finer failure reason, with their cost                      | Traces at `ERROR` level                                       | Query G      |
| Cache efficiency            | Share of prompt tokens read from the cache                                | Generation usage details                                      | Query H      |
| User feedback               | Ratings per response type; negative ratings with their trace              | Score `user_feedback`                                         | Query I      |
| Prompt version              | First-try rate, repairs, errors, cost and latency per prompt version      | Filter or group traces by `version`                           | Query J      |
| Guardrail signals           | Runs with injection signals, blocked canary leaks, provider refusals      | Scores `injection_signals`, `canary_leak`, `provider_refusal` | Logs only    |

The Langfuse dashboards will be built when the keys exist (milestone 7). Until then, and always for
spending, the database answers. The queries below match the schema of
`services/api/migrations/` (they were run against a freshly migrated database). Amounts are USD.

```sql
-- A. Cost per conversation, last 7 days
SELECT conversation_id,
       count(*)                AS runs,
       round(sum(cost_usd), 4) AS cost_usd,
       sum(input_tokens)       AS uncached_input_tokens,
       sum(cache_read_tokens)  AS cache_read_tokens,
       sum(output_tokens)      AS output_tokens
FROM agent_runs
WHERE created_at >= now() - interval '7 days'
GROUP BY conversation_id
ORDER BY cost_usd DESC
LIMIT 20;

-- B. Daily spend (UTC), the figure the daily cap compares with DAILY_BUDGET_USD
SELECT date_trunc('day', created_at AT TIME ZONE 'UTC') AS day_utc,
       count(*)                                         AS runs,
       round(sum(cost_usd), 4)                          AS cost_usd
FROM agent_runs
GROUP BY 1
ORDER BY 1 DESC
LIMIT 14;

-- C. Data tool calls: failure rate and latency per tool, last 7 days
SELECT call ->> 'name'                                             AS tool,
       count(*)                                                    AS calls,
       count(*) FILTER (WHERE NOT (call ->> 'ok')::boolean)        AS failures,
       round(100.0 * count(*) FILTER (WHERE NOT (call ->> 'ok')::boolean) / count(*), 1)
                                                                   AS failure_pct,
       percentile_cont(0.95) WITHIN GROUP (ORDER BY (call ->> 'durationMs')::numeric)
                                                                   AS p95_ms
FROM agent_runs r
CROSS JOIN LATERAL jsonb_array_elements(r.tool_call_log) AS call
WHERE r.created_at >= now() - interval '7 days'
GROUP BY 1
ORDER BY failure_pct DESC;

-- D. Run latency and steps, by status, last 7 days
SELECT status,
       count(*)                                                 AS runs,
       percentile_cont(0.5)  WITHIN GROUP (ORDER BY latency_ms) AS p50_ms,
       percentile_cont(0.95) WITHIN GROUP (ORDER BY latency_ms) AS p95_ms,
       round(avg(steps), 2)                                     AS mean_steps,
       max(steps)                                               AS max_steps
FROM agent_runs
WHERE created_at >= now() - interval '7 days'
GROUP BY status;

-- E. Repairs and first-try validity, per day
SELECT date_trunc('day', created_at)                             AS day,
       count(*)                                                  AS runs,
       round(avg(schema_valid_first_try::int), 3)                AS first_try_rate,
       count(*) FILTER (WHERE repairs > 0)                       AS runs_with_repair,
       count(*) FILTER (WHERE failure_reason = 'invalid_output') AS invalid_after_repair,
       count(*) FILTER (WHERE failure_reason = 'truncated')      AS truncated,
       count(*) FILTER (WHERE failure_reason = 'step_limit')     AS step_limit,
       count(*) FILTER (WHERE failure_reason = 'cost_ceiling')   AS cost_ceiling
FROM agent_runs
GROUP BY 1
ORDER BY 1 DESC
LIMIT 14;

-- F. Response types and decline reasons, last 7 days
SELECT response_type,
       response ->> 'reason'                              AS decline_reason,
       count(*)                                           AS runs,
       round(100.0 * count(*) / sum(count(*)) OVER (), 1) AS pct
FROM agent_runs
WHERE status = 'ok' AND created_at >= now() - interval '7 days'
GROUP BY 1, 2
ORDER BY runs DESC;

-- G. Failures by code and reason, with what they cost, last 7 days
SELECT error_code, failure_reason, count(*) AS runs, round(sum(cost_usd), 4) AS cost_usd
FROM agent_runs
WHERE status = 'error' AND created_at >= now() - interval '7 days'
GROUP BY 1, 2
ORDER BY runs DESC;

-- H. Prompt cache: share of prompt tokens read from the cache, per day
SELECT date_trunc('day', created_at) AS day,
       sum(input_tokens)             AS uncached_input,
       sum(cache_write_tokens)       AS cache_write,
       sum(cache_read_tokens)        AS cache_read,
       round(sum(cache_read_tokens)::numeric
             / nullif(sum(input_tokens + cache_write_tokens + cache_read_tokens), 0), 3)
                                     AS cache_read_share
FROM agent_runs
GROUP BY 1
ORDER BY 1 DESC
LIMIT 14;

-- I. Negative feedback, newest first, with the trace to open
SELECT r.created_at, r.trace_id, r.response_type, f.comment
FROM feedback f
JOIN agent_runs r ON r.id = f.run_id
WHERE f.rating = -1
ORDER BY r.created_at DESC
LIMIT 20;

-- J. Prompt versions side by side, last 14 days: compare the runs before and after a change
SELECT prompt_version,
       min(created_at)                                              AS first_run,
       max(created_at)                                              AS last_run,
       count(*)                                                     AS runs,
       round(avg(schema_valid_first_try::int), 3)                   AS first_try_rate,
       round(avg(repairs), 3)                                       AS mean_repairs,
       round(100.0 * count(*) FILTER (WHERE status = 'error') / count(*), 1)
                                                                    AS error_pct,
       round(avg(cost_usd), 6)                                      AS mean_cost_usd,
       percentile_cont(0.95) WITHIN GROUP (ORDER BY latency_ms)     AS p95_ms
FROM agent_runs
WHERE created_at >= now() - interval '14 days'
GROUP BY prompt_version
ORDER BY first_run;
```

In Langfuse, the same questions are filters on the traces table: `version` for a prompt version,
a score (for example `injection_signals` above 0, `canary_leak` = 1 or `repairs` above 0) for
the runs to open, and the environment (`production` or `eval`) so that evaluation traffic does
not mix with users'.

Reading notes:

- `input_tokens` is the uncached part of the prompt; cache reads and cache writes are counted
  apart, as the provider reports them. The prompt size of a call is their sum.
- `INVALID_OUTPUT` covers four failure reasons: `invalid_output` (still invalid after the repair,
  or plain text after the reminder), `truncated` (`max_tokens`), `step_limit` and `cost_ceiling`.
  Always read `failure_reason` with it. `LLM_TIMEOUT` splits into `llm_timeout` (one call) and
  `run_deadline` (the whole run); `INTERNAL_ERROR` splits into `crash` (the runtime threw) and
  `persistence` (the turn could not be committed); `CANCELLED` means the client left.
- `prompt_version` is null for runs recorded before its migration; query J shows them as one
  group.
- `tool_call_log` holds the data tool calls only, each with `name`, `input`, `ok`, `durationMs`
  and the `summary` the UI shows (for a failure, the message the model received).

## 3. Diagnosing a regression

The method is the same for every symptom:

1. **Confirm and size it in the database.** Compare a window before and after the suspected change
   (deploy time, configuration change) with the queries above. A change smaller than the noise of
   a few dozen runs is not a regression yet.
2. **Pick examples.** Select a handful of affected runs and their `trace_id`.
3. **Read the traces step by step.** The generations in order show what the model was given and
   what it decided; the tool observations show what it received.
4. **Name the cause, then reproduce it offline.** Run the matching evaluation cases
   (`npm run eval:agent -- --cases <ids>` or `--category <c>`), compare with an earlier run
   (`--compare <run dir>`), fix, and add the failing input as a new case so it stays fixed.

The prompt version (`agent_runs.prompt_version`, the `version` of every trace, logged at startup;
it changes with the system prompt template, any tool description or schema, and the model), the
effort (`LLM_EFFORT`) and the deployed commit are the first things to compare across the two
windows (query J).

### A sudden cost increase

1. **Size it:** query B for the day, query A for the conversations behind it, query D for steps.
2. **Split the cost** into calls per run and tokens per call:
   - **more tokens per call, mostly cache writes** (query H: `cache_read_share` falls,
     `cache_write` rises): the cached prefix changed. The prefix is the tool list, then the system
     prompt (rules, destination catalog, canary). Anything that changes it makes every call write
     the cache again: an edited tool description, a re-ingestion that changed the catalog, a new
     canary. The default canary is derived from `SESSION_SECRET`, so **rotating the session secret
     also changes the prompt**. In a trace, the generations of one run should show cache reads
     after the first call; cache creation on every call confirms it. A changed prefix also breaks
     the stored reasoning of ongoing conversations ([ADR 0007](adr/0007-llm-provider-abstraction-and-opaque-blocks.md));
   - **more calls per run** (`mean_steps` up): open a few traces and look for repeated
     `search_knowledge` calls with near-identical queries, a repair round (query E), a plain-text
     reminder, or tools retried after errors (query C);
   - **more output tokens**: a higher `LLM_EFFORT` (more reasoning) or longer itineraries;
   - **another price**: `LLM_MODEL` changed, or a prompt crossed a long-context threshold of the
     price table (long conversations close to the 12-turn cap).
3. **Bounds already in place:** the per-run ceiling stops a runaway run (`failure_reason =
'cost_ceiling'` in query G) and the daily cap stops the day. If either fires often, the cause
   above is the bug; raising the limit is not the fix.

### More `INVALID_OUTPUT` repairs

1. **Size it:** query E (first-try rate, runs with a repair, invalid after repair) and query G.
   Separate real validation failures from `truncated`, `step_limit` and `cost_ceiling`.
2. **Read what was rejected.** In the trace, the generation after the rejected terminal call has,
   at the end of its input, an `is_error` tool result that starts with "Your `<tool>` call was
   rejected and NOT shown to the user" and lists every issue. Group runs by issue:
   - a day count that differs from `durationDays`, or days out of order;
   - a `sourceRef` or `poiId` that no tool returned **in this run**: typical on follow-up turns,
     when the model cites what it saw in an earlier turn instead of calling the tools again;
   - a budget or weather figure that differs from the tool output it cites (rounding, conversion);
   - a place or chunk of another destination;
   - two terminal calls in one message, or a terminal call next to data tool calls.
3. **Find what changed:** the prompt version, the model or effort, a contract schema change (the
   strict tool schemas are generated from `packages/contracts`), or a tool description.
4. **`truncated`** means a call hit `maxOutputTokens` (16,000, reasoning included): check the
   output tokens of the last generation and whether a lower effort or a shorter output fixes it.
5. **Reproduce** with the clear and multi-turn evaluation cases: `schema_valid_first_try` must not
   drop, and `schema_valid_after_repair` is a hard gate at 100 %.

### A tool error spike

1. **Size it per tool:** query C. The `summary` of a failed call is what the model was told.
2. **Classify with the trace:** tool observations at `ERROR` level carry the internal message:
   - **timeouts** (5 s per tool): a slow database, a cold database after scale-to-zero, or the
     embedding model still loading after a restart (`GET /ready` reports the embedder). Check the
     latency column of query C and the platform metrics;
   - **invalid arguments or unknown destination ids**: the model misuses a tool. Look for a model,
     prompt or tool description change;
   - **unknown tool names**: the model invents tools, usually after a prompt change;
   - **database errors**: a migration or connection problem; `GET /ready` and the API logs tell.
3. **Expect knock-on effects:** failed calls go back to the model as `is_error` results and it may
   retry, so a spike also raises steps and cost (queries D and A).

### Retrieval returns the wrong destination

Symptoms: repairs for citations of another destination, `insufficient_data` declines for a
destination the corpus covers, negative feedback on itineraries.

1. **Find the searches:**

   ```sql
   SELECT r.created_at, r.trace_id,
          r.response -> 'brief' ->> 'destinationId' AS brief_destination,
          call -> 'input' ->> 'destinationId'      AS searched_destination,
          call -> 'input' ->> 'query'              AS query,
          call ->> 'summary'                       AS summary
   FROM agent_runs r
   CROSS JOIN LATERAL jsonb_array_elements(r.tool_call_log) AS call
   WHERE call ->> 'name' = 'search_knowledge'
     AND r.created_at >= now() - interval '1 day'
   ORDER BY r.created_at DESC;
   ```

2. **Read the `search_knowledge` observation** in the trace: its input (query, destination filter)
   and its output (each excerpt with its `destinationId`, section, fused `score` and `ranks`).
3. **Usual causes, in order:**
   - **no destination filter**: the model searched the whole corpus and got look-alike sections of
     other destinations. The tool description asks for `destinationId` when it is known;
   - **query not rewritten in English**: the guides and the full-text configuration are English;
     a French query weakens the lexical list (the vector list still helps);
   - **wrong destination in the brief**: check the context block of the user turn in the first
     generation's input (an alias resolved to the wrong catalog id);
   - **a corpus change**: a re-ingestion changed the chunks; re-run the retrieval evaluation and
     compare with `evals/baselines/retrieval.json`;
   - **fewer results than asked with a filter**: the retriever uses pgvector's iterative index scan
     so that a destination filter cannot starve the HNSW result list; an integration test covers
     it, so this would be a regression in `pg-retriever.ts`.
4. **Read the ranks.** Each excerpt of the observation carries `ranks.vector` and
   `ranks.fullText` (1-based, null when absent from that list): an excerpt that only one list
   found shows which list brought it, and a right section missing from both lists is a recall
   problem, not a fusion one. To keep the query as a regression test, add it to
   `evals/datasets/retrieval.yaml` with its labels.
5. **What protects the user meanwhile:** grounding rejects citations of chunks from another
   destination, so a wrong retrieval costs a repair or a decline, not a wrong citation.

### An injection attempt

1. **Detect:** the warn log `prompt injection signals` (`user:` signals for direct attempts,
   `tool:` signals for text planted in a guide) or traces whose `injection_signals` score is above
   0 (the names are in its comment), the error log about the canary or `canary_leak` = 1, declines
   with reason `unsafe` (query F), and provider refusals (`provider_refusal` = 1).
2. **Read the trace:** the user's text in the trace input; for a `tool:` signal, the tool output
   that carried the planted text (the guides come from Wikivoyage, which anyone can edit); then
   whether the following generations changed course (unrelated searches, an answer quoting
   instructions).
3. **Assess the blast radius:** the tools are read-only, so the worst case is a bad text. The
   canary check blocks verbatim prompt leaks, and grounding blocks citations the run did not
   retrieve. A blocked canary leak looks like a correct decline to the user but is a model
   failure: count it as one.
4. **Respond:** if a corpus document carries the instruction, fix the corpus and re-ingest; add
   the attempt as a `direct_injection` or `indirect_injection` evaluation case; only if the
   evaluation shows that the existing layers fail, consider a dedicated classifier
   ([ADR 0010](adr/0010-layered-guardrails.md)).

## 4. Real case diagnosed with traces

**Pending.** This section will be written from the first real Langfuse traces, after the
deployment and the first real evaluation run. No trace exists yet, so no case is described here.

Meanwhile, these are real incidents met during development. They are documented in the repository
history and the ADRs; **none of them was diagnosed with traces**.

- **Non-deterministic full-text ordering** (commit `4697b76`, 2026-10-10). Two identical runs of
  the retrieval evaluation returned different results. Full-text results with equal `ts_rank_cd`
  were ordered by chunk id, a random UUID that changes with every ingestion, and the evaluation
  ingests into a fresh scratch database for each run. Ties are now ordered by document path and
  chunk position, so the list is the same after a re-ingestion. The lesson for diagnosis: diffing
  two runs that should be identical is a test of the measurement itself, and it has to pass before
  any comparison between configurations means something.
- **The embedding runtime crashes on Windows** ([ADR 0004](adr/0004-local-embeddings.md)).
  `onnxruntime-node` 1.30 crashes with a segmentation fault when it creates the inference session
  on the Windows development host, with Node 24 and Node 20, while the tokenizer alone works.
  Linux is not affected; every real-model run goes through a Linux container.
- **A canary accepted by configuration but rejected at runtime** (commit `a8c938a`). The leak
  detector compares letters and digits only and needs at least 16 of them, while the configuration
  accepted a token made mostly of separators, which then failed at runtime. The configuration now
  validates the token the way the detector reads it.
- **Cancelled runs logged as server errors** (commit `ab0a78c`). A closed tab or a retry is
  expected, yet it produced error-level logs. It is now logged at info level as a cancellation and
  the run is recorded as `CANCELLED`, so error logs keep meaning "something is broken".

## 5. Known gaps

Listed so nobody relies on data that is not there:

- **Guardrail signals are not in `agent_runs`**: they are logs and trace scores only, so without
  Langfuse keys, counting injection attempts means searching the logs.
- **No alerting.** Nothing pages anyone; platform metrics and Neon monitoring are listed in
  [DEPLOYMENT.md](DEPLOYMENT.md#14-monitoring).
- **No sampling or masking.** Every run is traced in full; revisit if volume or privacy requires
  it.
- **One Langfuse project for production and evaluation traces**, separated by environment and
  tags: a dashboard that does not filter on the environment mixes them.
