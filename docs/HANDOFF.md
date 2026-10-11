# Handoff: state of the project and next steps

Snapshot of 2026-10-11. Give this page to anyone (or any AI coding session) who continues the
work. It says what exists, what has been verified and how, what has **not** been verified, and the
next steps in order. Facts here come from runs made on that date; re-run the commands before
relying on a number.

## 1. What exists

- **Product**: a travel-planning agent. It is a hand-written tool-calling loop over Claude:
  - data tools for knowledge search, weather, budget and points of interest;
  - terminal tools for the itinerary, a clarification, an answer and a decline;
  - Zod validation plus grounding checks, with one repair attempt.

  Around it:
  - hybrid RAG on Postgres + pgvector, fed by a Wikivoyage corpus of 20 destinations and 89 documents;
  - a Fastify API with anonymous sessions and Server-Sent Events;
  - a React chat UI that shows sources and tool calls;
  - Langfuse tracing behind a port;
  - an offline evaluation pipeline with a CI gate.

- **Code map**: start with [`../README.md`](../README.md) for the architecture, then:
  - [`INTERVIEW_NOTES.md`](INTERVIEW_NOTES.md) (French) for the path of one request;
  - the [ADRs](adr/README.md) for every decision (0001–0013).
- **Branches**:
  - `main` holds the project;
  - `learning/agent-loop`, `learning/chunking-rrf` and `learning/eval-metrics` are exercise
    branches ([`LEARNING.md`](LEARNING.md)). Never merge them into `main`.
- **Not in the repository, on purpose**:
  - `.env`, which holds the secrets;
  - eval results (`evals/results/`);
  - the model cache (`.cache/`);
  - the seeded Docker volume, which `make seed` recreates.

  The original project brief and plan (French) live outside the repository, in the owner's
  files.

## 2. Verified, and how

| What                                         | How it was checked                                                                                                  | Result on 2026-10-11                                                                                                                                                                      |
| -------------------------------------------- | ------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Types, lint, format                          | `npm run typecheck`, `npm run lint`, `npm run format:check`                                                         | all pass                                                                                                                                                                                  |
| Unit tests                                   | `npm test`                                                                                                          | 1,173 pass: contracts 43, api 599, web 291, evals 110, data 130                                                                                                                           |
| Integration tests (real Postgres + pgvector) | `make test-integration`                                                                                             | 55 pass                                                                                                                                                                                   |
| Coverage gate (domain + application ≥ 80 %)  | `npm run test:coverage -w @wanderly/api`                                                                            | passes                                                                                                                                                                                    |
| Whole stack                                  | `docker compose up --build -d --wait`, then through nginx on :8080: `/ready`, create a conversation, send a message | db, migrate, seed, api, web healthy. `/ready` passes (database, migrations, embedder). Without an API key the stream returns `run.started` then the curated `PROVIDER_UNAVAILABLE` event. |
| Retrieval quality                            | `make eval-retrieval-docker`                                                                                        | measured, see [`EVALUATIONS.md`](EVALUATIONS.md) (structure-aware chunking beats fixed-size; hybrid is not measurably better than vector-only)                                            |
| Evaluation harness wiring                    | `make eval` (keyless controls through the real agent loop)                                                          | oracle 100 %, null baselines score low, all three harness checks pass                                                                                                                     |
| Images                                       | Trivy, hadolint                                                                                                     | no fixable HIGH/CRITICAL; Dockerfiles clean                                                                                                                                               |
| Workflows                                    | actionlint                                                                                                          | clean                                                                                                                                                                                     |

## 3. Not verified yet

These are the main risks: plan for fixes when each one happens for the first time.

1. **Real Claude calls.** Everything ran against a scripted fake LLM. The first real run will
   exercise these points for the first time:
   - the strict tool schemas, including nullable enums;
   - prompt-cache hits;
   - replaying reasoning blocks across turns (append-only history);
   - the served-model check;
   - `npm run chat`.

   Expect one or two fixes.

2. **The agent evaluation baseline.** There are no real numbers yet. The soft quality gates in
   `evals/thresholds.json` stay "pending first baseline" on purpose, and the hard gates are
   active.
3. **Langfuse.** The export was tested against a local stand-in server, not against Langfuse
   Cloud. The "real case diagnosed with traces" section of
   [`OBSERVABILITY.md`](OBSERVABILITY.md) is still pending.
4. **GitHub CI.** The workflows have never run on GitHub. The first run on `main` ingests the
   corpus, which takes about 10 minutes, and caches it.
5. **Deployment on Fly.io + Neon.** Nothing is deployed. The `fly.toml` files were not parsed by
   flyctl, and some items are marked `TODO(first deploy)` in [`DEPLOYMENT.md`](DEPLOYMENT.md):
   - the Fly proxy's real IP range;
   - whether Flycast keeps `X-Forwarded-For`;
   - cold-start time.
6. **Human review of the datasets.** The 53 retrieval queries and 45 agent cases were proposed
   by an agent and are tagged `pending human review`. The judge-calibration set is empty.

## 4. Next steps, in order

1. **Push to GitHub.**
   - Create an empty repository `patrickz24/wanderly`, add it as `origin` over HTTPS, and push
     `main` (and the `learning/*` branches if wanted).
   - After checking the push, delete the local safety ref:
     `git update-ref -d refs/backup/main-before-split`.
   - In the repository settings:
     - add the secret `ANTHROPIC_API_KEY` (a separate key from the local one);
     - enable private vulnerability reporting and secret scanning with push protection;
     - turn off CodeQL "default setup", since the repository ships its own workflow.
2. **First real agent evaluation.**
   - Put `ANTHROPIC_API_KEY` in `.env`, then run `make eval-agent-docker` (capped by
     `MAX_USD=2`).
   - Read the transcripts in `evals/results/<run>/`, fix what the run reveals, then re-run.
   - Copy the reviewed `proposedSoftThresholds` from `summary.json` into
     `evals/thresholds.json`, run once more with `--write`, and commit the baseline.
   - Optional comparison with Sonnet as the agent:
     `npm run eval:agent -- --model claude-sonnet-5-5 --max-run-usd 1 --max-usd 10`
     (in the container on Windows).
3. **Judge calibration.**
   - Export about 25 judged outputs:
     `npm run eval:judge-calibration -- --export evals/results/<run>`.
   - Label them by hand following the instructions in
     `evals/datasets/judge-calibration.yaml`, then run the agreement script.
   - Report the agreement and Cohen's κ in [`EVALUATIONS.md`](EVALUATIONS.md).
4. **Langfuse.**
   - Put the EU Cloud keys in `.env`, run the stack, and have a few real conversations.
   - Write the real diagnosed case in [`OBSERVABILITY.md`](OBSERVABILITY.md), from an actual
     trace only.
5. **Deploy.**
   - Follow [`DEPLOYMENT.md`](DEPLOYMENT.md): Fly.io accounts and tokens, a Neon database,
     `make seed-remote`, then `make deploy`.
   - Resolve the `TODO(first deploy)` items and put the live URL in the README.
6. **Real users and demo.** Share the URL, collect feedback (the 👍/👎 buttons are stored and
   traced), and record the demo GIF for the README.
7. **Learning kit.** Work through [`LEARNING.md`](LEARNING.md) before interviews.

## 5. Working conventions

- **Language.** Code, comments, commits and docs are in English, except
  [`INTERVIEW_NOTES.md`](INTERVIEW_NOTES.md) and the learning kit, which are in French.
- **Commits.** Conventional Commits, small and atomic, authored as
  `patrickz24 <62058882+patrickz24@users.noreply.github.com>` (already set in the repository's
  local git config; set it again on another machine).
- **Pre-commit hook.** It runs `lint-staged --no-revert --fail-on-changes`, so it refuses a
  commit when formatting would change a file. Run `npm run format`, `git add` the files again,
  and commit.
- **Never invent numbers.** Every figure in the docs comes from a committed run or a command
  anyone can re-run; anything not measured is written as pending.
- **Windows.** The ONNX runtime of the local embedder crashes natively on the development host
  ([ADR 0004](adr/0004-local-embeddings.md)). Use the containers:
  - `make up` for the app;
  - `make seed`;
  - `make eval-*-docker` for the evaluations.
- **Git history.** It was rewritten locally before the first push, to split commits that
  parallel build agents had mixed. The final tree was checked identical to the pre-rewrite
  state. One commit (`feat(api): add the ingestion command`) still carries three intermediate
  web files, because that intermediate state does not pass ESLint and the hook was not bypassed.

## 6. Known limitations to keep in mind

- **Crowd and season data is sparse**, by design. It is lexical, with verbatim evidence: crowd
  level for 42 of 1,337 points of interest, best months for 84. The agent says when it does not
  know.
- **Costs come only from prices written in the guides.** Seiser Alm has none, and price units
  are mixed (per room, per person).
- **Single-instance limits.**
  - The rate limiter and the "one run per conversation" guard live in memory.
  - Deploys run one Machine with `--ha=false`.
  - The conversation list has no pagination (latest 50).
- **The evaluation calls `runAgent` with the production factories.** Persistence, sessions,
  turn and daily caps, rate limits and SSE are covered by the API integration tests instead.
- **The session cookie is not renewed.** A browser can lose access to a conversation before the
  30-day purge deletes it.
