# ADR 0011: Cost control with a daily cap, a per-run ceiling and per-IP limits

- **Status:** Accepted
- **Date:** 2026-10-10
- **Milestone:** 4

## Context

The demo is public and every message starts paid LLM calls. Nothing stops a script from
sending thousands of messages, and a single run can loop (repairs, tool calls). We need hard
bounds on spending that hold across restarts and instances, fail with a clear message, and are
checked before money is spent.

## Decision

Four layers, from the widest to the narrowest:

1. **Global daily cap** (`DAILY_BUDGET_USD`, default 2): before any LLM call, `SendMessage`
   sums `cost_usd` of the runs created during the current UTC day (`agent_runs`, indexed on
   `created_at` with `cost_usd` included). It refuses the run when the spending plus the
   per-run ceiling would exceed the cap: the ceiling is reserved up front, so one run cannot
   push the day past the cap. A cap of 0 is a kill switch.
   Refusal is a `503 BUDGET_EXCEEDED` JSON error, before the stream opens.
2. **Per-run ceiling** (`AGENT_MAX_RUN_COST_USD`, runtime default): the agent loop does not
   start a call whose worst-case cost could cross it (ADR 0006).
3. **Per-conversation limits:** at most 12 completed turns, and one run at a time per
   conversation (`409`).
4. **Per-IP rate limits** (`@fastify/rate-limit`, keyed by the client IP resolved through
   `TRUST_PROXY`): the message route allows `RATE_LIMIT_MAX` per `RATE_LIMIT_WINDOW_MS`
   (default 10 per 10 minutes); the cheap routes have a looser limit (`API_RATE_LIMIT_MAX` per
   `API_RATE_LIMIT_WINDOW_MS`, default 120 per minute). A `429 RATE_LIMITED` uses the error
   envelope with `Retry-After`.

Every run is recorded with its cost, including failed, crashed and cancelled ones: the LLM port
is metered per run, so the ledger keeps the spend even if the runtime throws.

## Consequences

### Positive

- The cap lives in the database: it survives restarts and is shared by every instance.
- Spending is bounded before it happens, not discovered on the invoice.
- Users get an actionable message for each limit; nothing internal leaks.

### Negative

- The cap is checked at the start of a run: concurrent runs can overshoot it by at most
  (concurrent runs × per-run ceiling).
- The rate limiter and the one-run-per-conversation guard are **in memory**: correct for one
  instance; several instances would each apply their own limits (Redis store needed, roadmap).
- IP limits are coarse: users behind one NAT share a limit, and an attacker with many IPs
  bypasses it (the daily cap still bounds the damage).
- Our cost is only as accurate as the price table (ADR 0008).

### Follow-ups

- Tune the ceiling and the limits with the evaluation's measured costs (milestone 5).
- Redis-backed rate limiting if the deployment ever runs more than one instance.

## Alternatives considered

- **Provider-side spending limit only:** a monthly limit in the provider console is kept as
  the last line of defence, but it cuts everything at once and is not visible to users.
- **Checking the cap after the run:** simpler, but the money is already spent.
- **Per-session quotas:** anonymous sessions are free to create (clear the cookie), so they
  cannot bound anything on their own.
