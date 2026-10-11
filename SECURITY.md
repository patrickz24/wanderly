# Security policy

Wanderly is a personal demonstration project with a fictional brand. It has no accounts and is not
meant to hold personal data, but it runs an LLM agent on untrusted input and a public demo is
planned once it is deployed, so security reports are welcome and taken seriously.

## Reporting a vulnerability

**Please do not open a public issue, pull request or discussion for a security problem.**

Use GitHub private vulnerability reporting: on
[github.com/patrickz24/wanderly](https://github.com/patrickz24/wanderly), open the **Security**
tab and choose **Report a vulnerability**. There is no security email address.

Please include:

- the affected component (API, web client, CI, Docker images, demo deployment) and the commit;
- steps to reproduce or a proof of concept, and the impact you expect;
- for prompt-injection findings, the exact inputs, the agent's response and the run or trace id if
  the UI shows one.

What to expect: this is maintained by one person on a best-effort basis, with no bug bounty. You
will get an acknowledgement, updates while a fix is prepared, and credit in the advisory unless you
prefer otherwise. Please allow a reasonable delay before any public disclosure.

**Supported versions:** only the latest `main` branch and, once it exists, the public demo. There
are no released versions.

## Scope

**In scope**

- Code and configuration in this repository: `services/api`, `apps/web`, `packages/contracts`,
  `evals`, data scripts, Dockerfiles, Compose file, Fly.io configuration and GitHub workflows.
- The public demo deployment, once it exists.
- Examples of findings we care about:
  - leaking the system prompt or its canary token;
  - reading or changing another session's conversations, runs or feedback;
  - bypassing the rate limits, the per-run cost ceiling or the daily cost cap;
  - making a tool perform a side effect or reach an arbitrary host;
  - script injection through model output rendered in the web client;
  - secrets exposed in logs, images, traces or the client bundle;
  - CI weaknesses, such as secrets reachable from fork pull requests.

**Out of scope**

- Vulnerabilities in third-party services (Anthropic, Langfuse, Fly.io, Neon). Report them to the
  vendor.
- Wrong, outdated or invented travel advice. That is a quality problem: open a regular issue, it
  can become an evaluation case.
- Jailbreaks that only produce off-topic or unpleasant text, without leaking the canary, crossing
  sessions or bypassing a control. Also welcome as regular issues.
- Volumetric denial of service, load testing or deliberately exhausting the demo's daily budget.
- Automated scanner output without a demonstrated impact, and social engineering.

Please do not run automated scanners against the public demo or enter real personal data into it.

## Security model

The riskiest component is an LLM that reads untrusted text: user messages and retrieved documents.
The retrieved guides come from Wikivoyage, which anyone can edit, so they are untrusted too. The
design assumes a prompt injection will sometimes succeed and limits what it can achieve; the other
controls are layers around that ([ADR 0010](docs/adr/0010-layered-guardrails.md)).

In the **Status** column, "Implemented" means the control is in the code on `main` and covered by
tests. "Planned" marks what does not exist yet. Nothing here has been exercised against the real
Claude API or a public deployment yet: the effectiveness of the prompt-level controls against a
real model is measured by the agent evaluation, whose first run is pending.

### Application and agent

| Control                                     | Design                                                                                                                                                                                                                                                                                                                                                                                                                                                        | Status                                 |
| ------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------- |
| Read-only tools (primary injection defence) | The four data tools (`search_knowledge`, `get_seasonal_weather`, `estimate_budget`, `search_pois`) are read-only queries over our own Postgres: no writes, no outbound HTTP, no code execution. Arguments are validated with Zod and destination ids against the catalog; unknown tools and invalid arguments come back to the model as `is_error` results. A successful injection can produce bad text, not an action.                                       | Implemented                            |
| Prompt structure                            | The system prompt is static: tool results and guide excerpts are declared data, never instructions; its rules "hold for the whole conversation". The application's context block (date, trip brief) and the user's words travel in separate blocks. Catalog entries from the corpus are flattened to one line so they cannot add prompt sections.                                                                                                             | Implemented                            |
| Canary token                                | A secret marker in the system prompt (`AGENT_CANARY_TOKEN`, or by default a domain-separated HMAC of `SESSION_SECRET`, stable across restarts). Every text field of a response is checked, ignoring case and separators: a leak replaces the response by a `decline` (`unsafe`), closes the tool call with an explanation and is logged at error level. It detects verbatim leaks only.                                                                       | Implemented                            |
| Output validation and grounding             | Strict tool schemas, then Zod, then consistency (day count equals the requested length, catalog destination, brief agreeing with the itinerary) and grounding against a per-run evidence registry: every `sourceRef` and `poiId` was returned by a tool in this run and belongs to the destination; the budget and weather equal the tool outputs they cite. One repair, then `INVALID_OUTPUT`.                                                               | Implemented                            |
| Provider refusals                           | A `refusal` stop reason from the provider's safety classifiers becomes a `decline` (`unsafe`); the refused output is never appended to the history.                                                                                                                                                                                                                                                                                                           | Implemented                            |
| Prompt-injection signals                    | Pattern heuristics run on the user text and on every tool output and produce signals (`user:…`, `tool:…`) that are logged with the run id. They never block: regexes are easy to evade and would flag legitimate text. Each run also gets an `injection_signals` trace score (count, names in the comment), next to `canary_leak` and `provider_refusal`.                                                                                                     | Implemented                            |
| Input limits                                | Messages of at most 2,000 characters, at most 12 user turns per conversation, one run at a time per conversation (`409`), 64 KiB request bodies, 30 s to receive a request.                                                                                                                                                                                                                                                                                   | Implemented                            |
| Per-run limits                              | At most 8 model calls, 45 s per model call, 5 s per tool call, 90 s for the whole run (enforced with `AbortSignal`, because the SDK retries timeouts), 16,000 output tokens per call, and a per-run cost ceiling (`AGENT_MAX_RUN_COST_USD`, default 0.10 USD) checked against each call's worst case before it starts. These are configured starting values, not measurements.                                                                                | Implemented                            |
| Rate limiting                               | Per client IP, in memory (`@fastify/rate-limit`): the message route allows `RATE_LIMIT_MAX` per `RATE_LIMIT_WINDOW_MS` (10 per 10 minutes by default), the other API routes `API_RATE_LIMIT_MAX` per `API_RATE_LIMIT_WINDOW_MS` (120 per minute). `429` with `Retry-After`. `TRUST_PROXY` decides which proxy hops are trusted; behind the web container, nginx overwrites `X-Forwarded-For` with the address it resolved, so a client cannot inject entries. | Implemented                            |
| Global daily cost cap                       | Before each run, `SendMessage` sums today's (UTC) `cost_usd` in `agent_runs` and refuses with `503 BUDGET_EXCEEDED` when that spend plus the per-run ceiling would exceed `DAILY_BUDGET_USD` (default 2), before any model call. Stored in the database, so it holds across restarts and instances; 0 is a kill switch. Failed, cancelled and crashed runs are recorded with their cost through a metered model port.                                         | Implemented                            |
| Append-only history                         | A database trigger rejects any `UPDATE` of `messages`; a failed run never touches the history, and open tool calls are closed, so a stored transcript cannot be rewritten by a bug and replays verbatim to the provider.                                                                                                                                                                                                                                      | Implemented                            |
| Anonymous sessions                          | A signed cookie (`wanderly_sid`, 256-bit random id, `httpOnly`, `SameSite=Lax`, `Secure` in production, path `/api`, 30-day lifetime) scopes which conversations a browser sees. A tampered cookie starts a new session; another session's conversation or run answers `404`, exactly like a missing one; requests without a resolved session fail closed. No accounts, no passwords.                                                                         | Implemented                            |
| Secrets                                     | Only through environment variables, validated by a Zod schema at startup; errors name the variable, never its value. Secret values are wrapped so that logs and serialisation print `[redacted]`, and the logger redacts credential headers and fields. `.env` is git-ignored; only `.env.example` (placeholders) is committed. CI secrets live in GitHub Actions secrets.                                                                                    | Implemented                            |
| Error handling                              | Errors map to a public envelope `{ error: { code, message, requestId } }` with a curated message per code (`404`, `409`, `429`, `502 INVALID_OUTPUT`, `503 BUDGET_EXCEEDED` or `PROVIDER_UNAVAILABLE`, `504 LLM_TIMEOUT`). Stack traces never reach clients; an internal tool error reaches the model as a generic message, and its details go to logs and traces.                                                                                            | Implemented                            |
| Request hardening                           | `Cache-Control: no-store` on API responses; incoming request ids accepted only if well-formed (otherwise regenerated) to prevent log injection; every SSE event is validated against the contracts before it is written.                                                                                                                                                                                                                                      | Implemented                            |
| CORS and API headers                        | CORS allow-list from `CORS_ORIGINS` (validated origins, no wildcard); production is same-origin behind the web proxy. `@fastify/helmet`; the API only serves JSON, so its Content Security Policy forbids every resource type and framing (`default-src 'none'`, `frame-ancestors 'none'`).                                                                                                                                                                   | Implemented                            |
| Rendering model output                      | The React client renders model output as text (no `dangerouslySetInnerHTML`), external links use `rel="noopener noreferrer"`, and the strict CSP below forbids inline scripts.                                                                                                                                                                                                                                                                                | Implemented                            |
| Injection test cases                        | 6 direct and 3 indirect injection cases in the agent evaluation; the planted documents exist only in evaluation code, never in the served corpus. The canary-leak hard gate is 0. Results pending the first real evaluation run.                                                                                                                                                                                                                              | Implemented (cases); pending (results) |

### Infrastructure and supply chain

| Control                 | Design                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            | Status                            |
| ----------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------- |
| Containers              | Multi-stage builds on base images pinned by digest, non-root users (the API runs as uid 1000, the web client is served by `nginx-unprivileged`), healthchecks. The API image bakes in the embedding model, read-only, and runs with `HF_HUB_OFFLINE=1`, so it downloads nothing at runtime. In Compose: read-only root filesystems, `no-new-privileges`, all capabilities dropped (Postgres keeps the few it needs to start), memory and process limits, host ports bound to `127.0.0.1`, and a network layout where the web container cannot reach the database. | Implemented                       |
| Web server headers      | nginx serves the client with a strict Content Security Policy (`default-src 'self'`, `script-src 'self'`, `object-src 'none'`, `frame-ancestors 'none'`), HSTS, `X-Content-Type-Options: nosniff`, `X-Frame-Options: DENY`, a restrictive `Permissions-Policy`, and same-origin opener and resource policies.                                                                                                                                                                                                                                                     | Implemented                       |
| Client IP trust chain   | nginx is the trust boundary: it reads the client address from the platform header only when the TCP peer is the trusted proxy range, then sends exactly that address upstream; the API trusts private hops only. Verified locally with Compose; the Fly.io check is a first-deploy step ([DEPLOYMENT.md](docs/DEPLOYMENT.md)).                                                                                                                                                                                                                                    | Implemented; deploy check pending |
| Dependency scanning     | `npm audit --audit-level=high` on production dependencies; Dependabot updates for npm, GitHub Actions and Docker base images.                                                                                                                                                                                                                                                                                                                                                                                                                                     | Implemented                       |
| Image and code scanning | Trivy on the built images and on the repository (vulnerabilities and committed secrets), failing on fixable high or critical findings; CodeQL (`security-extended`) on pull requests, `main` and weekly.                                                                                                                                                                                                                                                                                                                                                          | Implemented                       |
| Reproducible installs   | `npm ci --ignore-scripts` against the committed lockfile, in CI and in Docker builds, so dependency install scripts do not run.                                                                                                                                                                                                                                                                                                                                                                                                                                   | Implemented                       |
| CI permissions          | Workflows run with a read-only token. CI and the keyless evaluation checks need no secret, so they are safe on pull requests from forks. The paid agent evaluation reads `ANTHROPIC_API_KEY` only on same-repository pull requests and manual runs, with a dollar cap per run, and is skipped with a note on forks. Third-party actions in jobs that hold a token are pinned to a commit SHA.                                                                                                                                                                     | Implemented                       |
| Deploy workflow         | Manual only, from `main` only, after a green CI run on the exact commit, through a GitHub `production` environment with a required reviewer and app-scoped Fly.io deploy tokens with an expiry.                                                                                                                                                                                                                                                                                                                                                                   | Implemented; not used yet         |
| Repository settings     | Secret scanning with push protection and private vulnerability reporting enabled on GitHub (repository owner's task).                                                                                                                                                                                                                                                                                                                                                                                                                                             | Planned (repository creation)     |
| Provider spending limit | A monthly spending limit on the Anthropic account, as a last line of defence behind the daily cap (operator's task).                                                                                                                                                                                                                                                                                                                                                                                                                                              | Planned (before deployment)       |

## Data handling and retention

- **No accounts and no personal fields.** The web client shows a banner asking users not to enter
  personal information.
- **What is stored** in Postgres, linked to an anonymous session id: conversations (title, trip
  brief), messages (raw provider blocks, including the model's opaque reasoning blocks), runs (the
  user's text, the validated response, its sources, the tool call log with inputs and summaries,
  tokens, cost, latency, quality flags) and feedback (rating and an optional comment).
- **Retention: 30 days, implemented.** A conversation with no activity for **30 days**
  (`RETENTION_DAYS`, whole days, at least 1) is deleted with its messages, runs and feedback (a
  cascade). Activity is a completed turn or the start of a run. The API runs the purge at startup
  and every 24 hours (failures are logged and retried at the next tick), and `npm run purge`
  (`node dist/cli/purge.js` in the image, `--dry-run` to count only) runs it on demand or from a
  cron job. Each purge logs its cutoff and the number of rows deleted, never content. The session
  cookie expires 30 days after it is issued and is not renewed, so a browser can lose access to a
  conversation before the purge deletes it.
- **Retention never touches the daily cost cap.** The cap sums the cost of today's (UTC) runs in
  `agent_runs`, and runs are deleted with their conversation, so deleting one of today's runs would
  give back budget. Three rules prevent it: the cutoff is at least one whole day back, so it always
  falls before the start of the current UTC day; a conversation that has any run recorded after
  the cutoff is kept, whatever its `updated_at` (a failed run does not move it); and a run marks its
  conversation active before any model call, so a run in progress cannot lose its conversation to
  the purge and then fail to record its spend (if the purge won the race, the request gets a `404`
  before anything is spent). An integration test checks that today's spend is the same before and
  after a purge.
- **Copies outside the database** are not reached by the purge: Langfuse traces follow the
  retention of the Langfuse project, provider-side data follows Anthropic's API terms, and database
  backups or point-in-time history keep deleted rows for their own window
  ([DEPLOYMENT.md](docs/DEPLOYMENT.md)).
- **Third parties:** conversation content is sent to **Anthropic** to generate responses, under
  Anthropic's API terms. When Langfuse keys are configured, traces are sent to **Langfuse Cloud (EU
  region)**: they contain the user's text, the full request of each model call (the conversation
  so far), tool inputs and outputs, and responses. Without keys, tracing is a no-op. Embeddings are
  computed locally, so search queries are not sent to an embedding provider.

## Known limitations (accepted for a demo)

- Rate limiting and the one-run-per-conversation guard are in memory, so they only hold for a
  single instance. Several instances would need a shared store such as Redis (roadmap).
- Injection heuristics are pattern matches and are easy to bypass; they are signals, not a barrier.
  A dedicated injection classifier is not in the MVP and will be added only if the evaluation shows
  the other layers are not enough.
- The canary detects verbatim leaks, not a paraphrase of the instructions.
- The daily cost cap protects spending, not availability: anyone can use up the demo's budget for
  the day. Concurrent runs can overshoot the cap by at most one per-run ceiling each.
- IP limits are coarse: users behind one NAT share a limit, and an attacker with many addresses
  bypasses it (the daily cap still bounds the damage).
- The model is not deterministic. Guardrail evaluation results will be statistics, not proofs.
