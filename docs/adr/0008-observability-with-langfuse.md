# ADR 0008: Observability with Langfuse behind a `Tracer` port

- **Status:** Accepted
- **Date:** 2026-10-10
- **Milestone:** 3

## Context

An agent run is a loop of LLM calls and tool calls whose behaviour varies from run to run.
Debugging it from logs alone is guesswork: we need, per run, every LLM call with its input,
output, tokens and cost, every tool call with its result or error, and online quality signals,
grouped by conversation. The project must also run without any observability account (forks,
CI, a reviewer's laptop), and the domain must stay free of vendor SDKs (ADR 0002).

## Decision

The domain reports what happened through a `Tracer` port (`src/domain/ports/tracer.ts`), after
the fact and with explicit timings. A Langfuse adapter
(`src/infrastructure/tracing/langfuse-tracer.ts`, Langfuse JS SDK v5 on OpenTelemetry) maps it:

- one **trace** per agent run: a root observation of type `agent`, named `agent-run`, with the
  user text as input and the response as output; `sessionId` = conversation id, so Langfuse
  shows the cost per conversation; tags (`api`, the environment, or `eval` …);
- one **generation** per LLM call, with the model, token usage (input, output, cache reads and
  writes) and **the cost we computed** from our own price table (`src/domain/pricing.ts`), the
  same number the daily budget cap uses;
- one **tool** observation per tool call, at `ERROR` level when it failed;
- numeric **scores**: `schema_valid_first_try`, `citations_ok`, `tool_errors` (online checks
  of every run) and `user_feedback` (+1/-1, from the UI, attached to a past trace).

Trace attributes (name, session, tags) are set on every observation, not only the root, because
Langfuse aggregates by session only over observations that carry them. Observations are created
with explicit start/end times and an explicit parent in an **isolated** OpenTelemetry tracer
provider: no global registration, no auto-instrumentation, no reliance on async context.

Tracing is enabled only when `LANGFUSE_PUBLIC_KEY` and `LANGFUSE_SECRET_KEY` are both set
(`LANGFUSE_BASE_URL` defaults to the EU cloud). Otherwise the composition root uses
`NOOP_TRACER`. Every adapter operation catches its own errors and logs them: tracing never
changes the outcome of a run. Shutdown flushes buffered spans and scores.

## Consequences

### Positive

- One place to diagnose a run: its steps, latencies, failing tools and cost, grouped by
  conversation, with online scores to filter on.
- Dashboards and the budget cap agree on cost, because both use our computation.
- The app runs unchanged without keys; tests check the mapping with an in-memory exporter.

### Negative

- Conversation content (user text, tool results) leaves our infrastructure for Langfuse
  Cloud; retention and the "no personal data" banner (SECURITY.md) must cover it.
- Our cost is only as right as our price table; a provider price change needs a code change.
- Spans are buffered: a crash can lose the last seconds of traces (the database still holds
  every run's accounting in `agent_runs`).

### Follow-ups

- Dashboards and the real diagnosed case go in `docs/OBSERVABILITY.md` (milestone 7/8).
- If trace volume or privacy becomes a concern: sampling, or masking tool outputs.

## Alternatives considered

- **Logs only (pino):** no per-run tree, no session cost view, no scores. Kept for request
  and error logs, which carry the run and trace ids.
- **Langfuse's cost inference from model definitions:** would duplicate our price table and
  could disagree with the budget cap.
- **Global `NodeSDK` registration:** also installs OTLP log/metric exporters by default and
  would pick up any other instrumentation; we only need our own spans.
- **Self-hosted Langfuse:** v3 needs ClickHouse, Redis and object storage: too heavy for the
  compose stack (plan §1.2).
