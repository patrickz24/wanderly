# Security policy

Wanderly is a personal demonstration project with a fictional brand. It has no accounts and is not
meant to hold personal data, but it runs an LLM agent on untrusted input and a public demo is
planned for milestone 7, so security reports are welcome and taken seriously.

## Reporting a vulnerability

**Please do not open a public issue, pull request or discussion for a security problem.**

Use GitHub private vulnerability reporting: on
[github.com/patrickz24/wanderly](https://github.com/patrickz24/wanderly), open the **Security**
tab and choose **Report a vulnerability**. There is no security email address.

Please include:

- the affected component (API, web client, CI, Docker images, demo deployment) and the commit;
- steps to reproduce or a proof of concept, and the impact you expect;
- for prompt-injection findings, the exact inputs, the agent's response and the trace or run id if
  the UI shows one.

What to expect: this is maintained by one person on a best-effort basis, with no bug bounty. You
will get an acknowledgement, updates while a fix is prepared, and credit in the advisory unless you
prefer otherwise. Please allow a reasonable delay before any public disclosure.

**Supported versions:** only the latest `main` branch and, once it exists, the public demo. There
are no released versions.

## Scope

**In scope**

- Code and configuration in this repository: `services/api`, `apps/web`, `packages/contracts`,
  `evals`, data scripts, Dockerfiles, Compose file and GitHub workflows.
- The public demo deployment, once it exists (milestone 7).
- Examples of findings we care about:
  - leaking the system prompt or its canary token;
  - reading or changing another session's conversations;
  - bypassing the rate limit or the daily cost cap;
  - making a tool perform a side effect or reach an arbitrary host;
  - script injection through model output rendered in the web client;
  - secrets exposed in logs, images, traces or the client bundle;
  - CI weaknesses, such as secrets reachable from fork pull requests.

**Out of scope**

- Vulnerabilities in third-party services (Anthropic, Langfuse, the hosting provider). Report them
  to the vendor.
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
controls are layers around that.

In the **Status** column, "Milestone 1" marks controls delivered by the current milestone, the
foundation, which is still in progress. "Planned (milestone N)" marks controls that do not exist in
the code yet.

### Application and agent

| Control                                     | Design                                                                                                                                                                                                                                                                                                                                                                  | Status                |
| ------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------- |
| Secrets                                     | Only through environment variables, validated by a Zod schema at startup; an invalid configuration stops the process, and errors name the variable, never its value. Secret values are wrapped so that logs and serialisation print `[redacted]`. `.env` is git-ignored and only `.env.example` (placeholders) is committed. CI secrets live in GitHub Actions secrets. | Milestone 1           |
| Request validation                          | Routes declare Zod schemas for their inputs and responses (`fastify-type-provider-zod`): invalid requests get a `400`, and responses are serialised from their schema, so unexpected fields are not sent.                                                                                                                                                               | Milestone 1           |
| Error handling                              | Errors are mapped to a public envelope `{ error: { code, message, requestId } }`; 5xx responses always use a curated message. Stack traces never reach clients; details go to structured logs (and traces from milestone 3). Agent-specific errors are mapped at milestone 4.                                                                                           | Milestone 1           |
| Request hardening                           | Small request body limit, a timeout for receiving requests, `Cache-Control: no-store` on API responses, and incoming request ids accepted only if well-formed (otherwise regenerated) to prevent log injection.                                                                                                                                                         | Milestone 1           |
| Read-only tools (primary injection defence) | Every agent tool is a read-only query over the curated corpus and reference tables: no writes, no outbound HTTP, no code execution. A successful injection can produce bad text, not an action.                                                                                                                                                                         | Planned (milestone 3) |
| Prompt structure                            | Instructions and data are separated; tool results and documents are tagged with their source and declared to be data, never instructions. The system prompt carries a canary token.                                                                                                                                                                                     | Planned (milestone 3) |
| Input guard                                 | Message length capped at 2,000 characters and conversations at 12 turns. Injection heuristics are logged as signals, not used to block (see limitations).                                                                                                                                                                                                               | Planned (milestone 4) |
| Output checks                               | Terminal tools with strict schemas, then Zod and business validation: day count, points of interest belonging to the destination, every citation present in this run's tool results, budget equal to the tool output, canary detection. One repair attempt, then an explicit error.                                                                                     | Planned (milestone 4) |
| Per-run limits                              | Maximum agent steps, a timeout per LLM call and per tool, and a global run deadline enforced with `AbortSignal`.                                                                                                                                                                                                                                                        | Planned (milestone 3) |
| Rate limiting                               | Per client IP, in memory (`@fastify/rate-limit`, configured by `RATE_LIMIT_MAX` and `RATE_LIMIT_WINDOW_MS`), `429` with `Retry-After`. `TRUST_PROXY` controls whether the client IP is read from the proxy headers. The plugin is registered but opt-in per route, and no route uses it yet.                                                                            | Planned (milestone 4) |
| Global daily cost cap                       | Before each run, the API sums today's (UTC) run costs stored in Postgres and refuses with `503` once `DAILY_BUDGET_USD` is reached, before any LLM call. Stored in the database, so it holds across instances.                                                                                                                                                          | Planned (milestone 4) |
| CORS and security headers                   | CORS allow-list from `CORS_ORIGINS` (validated origins, no wildcard); production is same-origin behind the web proxy. `@fastify/helmet` headers; the API only serves JSON, so its Content Security Policy forbids every resource type and framing (`default-src 'none'`, `frame-ancestors 'none'`).                                                                     | Milestone 1           |
| Anonymous sessions                          | A signed cookie (`SESSION_SECRET`; `httpOnly`, `SameSite=Lax`, `Secure` in production) identifies a browser; conversations are only readable by their session. No accounts, no passwords. The cookie plugin and its defaults exist; sessions and conversations do not yet.                                                                                              | Planned (milestone 3) |
| Injection test cases                        | Direct and indirect injection cases in the evaluation set; the booby-trapped document exists only in evaluation fixtures, never in the served corpus.                                                                                                                                                                                                                   | Planned (milestone 5) |

### Infrastructure and supply chain

| Control                 | Design                                                                                                                                                                                                                                                                                                                                                                                                                             | Status                        |
| ----------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------- |
| Containers              | Multi-stage builds on base images pinned by digest, non-root users (the API runs as `node`, the web client is served by `nginx-unprivileged`), healthchecks. In Compose: read-only root filesystems, `no-new-privileges`, all capabilities dropped (Postgres keeps the few it needs to start), memory and process limits, host ports bound to `127.0.0.1`, and a network layout where the web container cannot reach the database. | Milestone 1                   |
| Web server headers      | nginx serves the client with a strict Content Security Policy (`default-src 'self'`, `frame-ancestors 'none'`), `X-Content-Type-Options: nosniff` and `X-Frame-Options: DENY`.                                                                                                                                                                                                                                                     | Milestone 1                   |
| Dependency scanning     | `npm audit --audit-level=high` on production dependencies; Dependabot updates for npm, GitHub Actions and Docker base images.                                                                                                                                                                                                                                                                                                      | Milestone 1                   |
| Image and code scanning | Trivy on the built images and on the repository (vulnerabilities and committed secrets), failing on fixable high or critical findings; CodeQL static analysis.                                                                                                                                                                                                                                                                     | Milestone 1                   |
| Reproducible installs   | `npm ci --ignore-scripts` against the committed lockfile, in CI and in Docker builds, so dependency install scripts do not run.                                                                                                                                                                                                                                                                                                    | Milestone 1                   |
| CI permissions          | Workflows run with a read-only token and need no secret, so they are safe on pull requests from forks. The Trivy action, whose tags were once force-pushed, is pinned to a commit SHA.                                                                                                                                                                                                                                             | Milestone 1                   |
| Repository settings     | Secret scanning with push protection and private vulnerability reporting enabled on GitHub (repository owner's task).                                                                                                                                                                                                                                                                                                              | Planned (repository creation) |
| Spending limit          | A monthly spending limit on the Anthropic account, as a last line of defence behind the daily cap (operator's task).                                                                                                                                                                                                                                                                                                               | Planned (milestone 7)         |

## Data handling and retention

- **No accounts and no personal fields.** The web client will show a banner asking users not to
  enter personal information (milestone 6).
- **What is stored:** conversation content (messages, tool calls and results, itineraries) and run
  metadata (tokens, cost, latency) in Postgres, linked to an anonymous session id.
- **Retention:** conversations older than **30 days** are deleted. Status: planned. Persistence
  arrives at milestone 3, and the purge job must run before the public demo opens (milestone 7).
- **Third parties:** conversation content is sent to **Anthropic** to generate responses, under
  Anthropic's API terms. When Langfuse keys are configured, traces containing prompts, tool inputs
  and outputs and responses are also sent to **Langfuse Cloud (EU region)**. Without keys, tracing
  is a no-op. Embeddings are computed locally, so search queries are not sent to an embedding
  provider.

## Known limitations (accepted for a demo)

- Rate limiting is in memory, so it only holds for a single instance. Several instances would need
  a shared store such as Redis (roadmap).
- Injection heuristics are pattern matches and are easy to bypass; they are signals, not a barrier.
  A dedicated injection classifier is not in the MVP and will be added only if evaluations show the
  other layers are not enough.
- The daily cost cap protects spending, not availability: anyone can use up the demo's budget for
  the day. The cap is checked before each run, so the last run of a day can exceed it by at most
  one run's cost, which per-run limits bound.
- The model is not deterministic. Guardrail evaluation results are statistics, not proofs.
