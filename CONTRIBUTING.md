# Contributing to Wanderly

Wanderly is a personal portfolio project built milestone by milestone. Issues, questions and
evaluation case ideas are very welcome. Pull requests are read, but may not be merged if they
conflict with the plan. For security problems, follow [SECURITY.md](SECURITY.md) instead of
opening an issue.

## Prerequisites

- **Node.js 22 or newer** (the version in `.nvmrc` is the supported floor and the one CI uses).
- **npm**, bundled with Node.js. No pnpm, Yarn or global tools are needed.
- **Docker** with the Compose plugin (`docker compose`), for Postgres, the full stack and anything
  that runs the embedding model on Windows.
- **Git**. Hooks are installed automatically by `npm ci`.
- **make** (optional): POSIX make and sh. On Windows, run it from Git Bash or WSL; the header of the
  `Makefile` gives the npm or Docker equivalent of every target.

### Windows and the embedding model

`onnxruntime-node`, which runs the local embedding model, crashes (segmentation fault) when it
creates its inference session on the Windows development host, with Node 20 and 24 alike
([ADR 0004](docs/adr/0004-local-embeddings.md)). Linux, Docker and CI are not affected. On
Windows, run everything that embeds text in a container:

| Task                  | On Windows                           |
| --------------------- | ------------------------------------ |
| Load the corpus       | `make seed` (Compose `seed` service) |
| Real agent evaluation | `make eval-agent-docker`             |
| Retrieval evaluation  | `make eval-retrieval-docker`         |
| Run the API           | `make up` (the API container)        |

The API loads the model at startup, so `make dev` and `npm run dev:api` are for Linux and macOS.
Unit tests, the keyless evaluation controls, lint, typecheck and the web dev server run natively
on Windows.

## Getting started

```bash
npm ci        # dependencies and Git hooks
make env      # .env from .env.example with a random SESSION_SECRET (never overwrites)
make up       # whole stack in Docker: db, migrate, seed, api, web on http://localhost:8080
```

For host-side development of the API or the web client:

```bash
make dev      # starts Postgres, migrates, then the API (:3000) and Vite (:5173) in watch mode
```

Without `make`: `cp .env.example .env` (set `SESSION_SECRET`), `docker compose up -d --wait db`,
export the variables of `.env` into your shell (`set -a; . ./.env; set +a` in Bash), then
`npm run migrate`, `npm run dev:api` and `npm run dev:web`.

The API validates its environment with Zod at startup and lists every invalid variable by name,
never by value. `.env.example` documents each variable. `DATABASE_URL` and `SESSION_SECRET` are
required; `ANTHROPIC_API_KEY` is needed for agent runs and `LANGFUSE_PUBLIC_KEY` /
`LANGFUSE_SECRET_KEY` (both or neither) for tracing. Without an API key the API starts and every
agent run ends with a "provider unavailable" error.

## Workspace layout

| Path                 | Package               | What lives there                                                                                        |
| -------------------- | --------------------- | ------------------------------------------------------------------------------------------------------- |
| `packages/contracts` | `@wanderly/contracts` | Shared Zod schemas and types: agent responses, API payloads, SSE events, corpus files.                  |
| `services/api`       | `@wanderly/api`       | Fastify API: `src/{domain,application,infrastructure,api}`, CLIs, SQL migrations, tests.                |
| `apps/web`           | `@wanderly/web`       | React + Vite + Tailwind client, with a demo mode (`?demo=1`) on sample data.                            |
| `evals`              | `@wanderly/evals`     | Retrieval and agent evaluations: datasets, scorers, LLM judge, runners, reports, thresholds, baselines. |
| `data/`              | none                  | Travel corpus and its generation scripts, see [`data/README.md`](data/README.md).                       |
| `docs/`              | none                  | ADRs, evaluations, observability, deployment and interview notes.                                       |

Every workspace is ESM (`"type": "module"`). In development, `@wanderly/contracts` resolves to its
TypeScript sources through a `development` export condition, so no build step is needed. Production
builds use its compiled `dist/`, which `npm run build` produces first.

## Scripts

Run from the repository root:

| Script                            | What it does                                                                                           |
| --------------------------------- | ------------------------------------------------------------------------------------------------------ |
| `npm run lint`                    | ESLint on the whole repository, including the layering rules.                                          |
| `npm run format`                  | Prettier, writing changes.                                                                             |
| `npm run format:check`            | Prettier, checking only (used in CI).                                                                  |
| `npm run typecheck`               | `tsc --noEmit` in every workspace and in `data/`.                                                      |
| `npm test`                        | Unit and component tests (Vitest) in every workspace and in `data/`. No database, no network.          |
| `npm run test:integration`        | API integration tests against a real Postgres + pgvector (`DATABASE_URL`, migrated).                   |
| `npm run build`                   | Builds every workspace, contracts first.                                                               |
| `npm run dev:api`                 | API in watch mode.                                                                                     |
| `npm run dev:web`                 | Vite dev server, proxying `/api`, `/health` and `/ready` to the API.                                   |
| `npm run migrate`                 | Applies pending SQL migrations to `DATABASE_URL`.                                                      |
| `npm run ingest`                  | Loads `data/corpus` into the database (idempotent; embeds on CPU; not on native Windows).              |
| `npm run chat -- "<request>"`     | Dev CLI: one real, billed agent turn against the ingested corpus, without HTTP.                        |
| `npm run eval:controls`           | Keyless controls: oracle and null policies through the real agent loop.                                |
| `npm run eval:agent -- <options>` | Agent evaluation (real model by default; see [Evaluations](#evaluations)).                             |
| `npm run eval:retrieval`          | Retrieval evaluation (vector, full text, hybrid; chunking variants).                                   |
| `npm run eval:judge-calibration`  | `-- --export <run dir>` adds judged outputs to label; without it, reports agreement and Cohen's kappa. |
| `npm run eval`                    | Retrieval evaluation, then the real agent evaluation.                                                  |

To target one workspace, add `-w`, for example `npm run test:coverage -w @wanderly/api`. The data
scripts are not a workspace: run them with `npx tsx data/scripts/<script>.ts`.

## Make targets

`make help` lists them. The main ones:

| Target                         | What it does                                                                                                   |
| ------------------------------ | -------------------------------------------------------------------------------------------------------------- |
| `make env`                     | Creates `.env` from `.env.example` with a random `SESSION_SECRET`; never overwrites.                           |
| `make up` / `make down`        | Builds and starts the whole stack and waits until healthy / stops it (keeps the database).                     |
| `make logs` / `make ps`        | Follows the logs (`SERVICE=api` for one service) / shows status and health.                                    |
| `make db` / `make migrate`     | Starts only Postgres / applies migrations (`DATABASE_URL` from the command line, `.env` or the local default). |
| `make seed`                    | Loads the corpus into the Compose database with the `seed` service (any OS).                                   |
| `make seed-remote`             | Same, into `SEED_DATABASE_URL` (for example the production database).                                          |
| `make dev`                     | Postgres, migrations, then the API and web dev servers.                                                        |
| `make test`                    | `npm test`.                                                                                                    |
| `make test-integration`        | Starts Postgres, migrates, runs the integration tests.                                                         |
| `make lint` / `make typecheck` | ESLint and the Prettier check / the type check.                                                                |
| `make eval`                    | The keyless evaluation controls.                                                                               |
| `make eval-agent`              | Real agent evaluation on the host (Linux or macOS); `MAX_USD` caps the spend (default 2).                      |
| `make eval-agent-docker`       | Same in a Linux container, after seeding (any OS).                                                             |
| `make eval-retrieval`          | Retrieval evaluation on the host (Linux or macOS).                                                             |
| `make eval-retrieval-docker`   | Same in a Linux container (any OS).                                                                            |
| `make build`                   | Builds every workspace.                                                                                        |
| `make deploy`                  | Deploys the API then the web app to Fly.io ([DEPLOYMENT.md](docs/DEPLOYMENT.md)).                              |
| `make clean`                   | Removes build outputs and coverage.                                                                            |

## Evaluations

Methodology, metrics and results are in [docs/EVALUATIONS.md](docs/EVALUATIONS.md); the decisions
are ADRs [0012](docs/adr/0012-evaluation-strategy-and-ci-gates.md) and
[0013](docs/adr/0013-llm-as-judge-and-calibration.md).

**Locally:**

- `npm run eval:controls` (or `make eval`): free, no key, any OS. The oracle must score 100 % and
  the two null policies must score low; run it after changing a scorer, the dataset or the loop.
- `make eval-agent-docker` (any OS) or `make eval-agent` (Linux, macOS): the real evaluation. It
  needs `ANTHROPIC_API_KEY` in `.env` and a seeded database, and it costs money: `MAX_USD` caps the
  whole run. Useful options of `npm run eval:agent --`: `--reps N` (variance and tighter
  intervals), `--category direct_injection,indirect_injection`, `--cases <ids>`,
  `--model claude-sonnet-5-5 --max-run-usd 1` (model comparison), `--compare <earlier run>`
  (paired differences), `--no-judge`, `--gate` (exit 1 when a gate fails) and `--write` (update the
  baseline and the results section of `docs/EVALUATIONS.md`).
- `make eval-retrieval-docker` or `make eval-retrieval`: the retrieval evaluation; it needs a role
  allowed to create databases. `-- --write` updates `evals/baselines/retrieval.json` and the
  results section of `docs/EVALUATIONS.md`.

Run outputs go to `evals/results/<timestamp>-<mode>/` (not versioned): one scored row per case,
infrastructure errors apart, full trajectories, a summary and a Markdown report. Never edit the
generated sections of `docs/EVALUATIONS.md` by hand.

**In CI** (`.github/workflows/eval.yml`, on pull requests that touch `services/`, `packages/`,
`evals/` or `data/corpus/`, on pushes to `main` that touch them, and on manual dispatch):

- `harness` (keyless, forks included): the scorer, judge and harness unit tests, then the three
  controls; a control that does not score as expected fails the job;
- `knowledge-base` (keyless): ingests the corpus once per change of the corpus, the ingestion
  code, the migrations or the model, and caches the database dump for the other jobs;
- `retrieval-eval` (keyless, forks included): the retrieval evaluation on the ingested knowledge
  base, with its table in the job summary; it reports, it does not gate;
- `agent-eval`: the real evaluation with `--gate` and a dollar cap, using the `ANTHROPIC_API_KEY`
  secret. It is skipped with a note on pull requests from forks (they get no secrets) and when
  the secret is not configured.

A pull request that changes the agent, the prompt, the tools or retrieval should describe its
evaluation impact. Soft thresholds are set from the first real baseline: they are pending until it
exists, and the gate reports them as pending, not as passed.

## Code style

- TypeScript strict, no `any` (use `unknown` and parse with Zod), no non-null assertions outside
  tests. These are lint errors, not suggestions.
- Small pure functions, explicit errors, no hidden I/O.
- Prettier owns formatting; do not hand-format.
- Never invent numbers (benchmarks, evaluation results, prices) in code or docs. Anything measured
  must come from running code; unknown values stay `null` with a note, or are marked pending.

## Layering rules

The API follows the layered design in
[ADR 0002](docs/adr/0002-layered-architecture-and-ports.md). ESLint (`no-restricted-imports` in
`eslint.config.js`) fails the build when a file breaks a boundary:

| Layer                | Must not import                                                                                                                                                                                                                 |
| -------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `src/domain/**`      | `application`, `infrastructure`, `api`, config modules; `fastify`, `@fastify/*`, `pg`, `pgvector`, `@anthropic-ai/*`, Langfuse, `@huggingface/*`, `@opentelemetry/*`; `node:fs`, `node:net`, `node:http*`, `node:child_process` |
| `src/application/**` | `infrastructure`, `api`, and the same infrastructure packages                                                                                                                                                                   |
| `src/api/**`         | `infrastructure` and the database, LLM, embedding and tracing packages: routes call use cases                                                                                                                                   |

Adapters are created and wired in one place, the composition root `services/api/src/main.ts`. The
factories shared with the evaluation live in `services/api/src/composition/`.

## Testing policy

- **Every behaviour change comes with a test.** Unit tests are co-located as `*.test.ts(x)`.
- **Unit tests never call a real LLM or the network.** The agent is tested with a fake LLM that
  implements the `LlmPort`, and other ports with in-memory fakes. Inject time through the `Clock`
  port.
- **Unit tests never assert on free text written by a model.** Assert on structure, tool calls and
  validation results.
- **Database code is tested against a real Postgres** in `services/api/test/integration/*.int.test.ts`
  (`make test-integration`), not with a mocked driver. They need a migrated `DATABASE_URL` whose
  role may create databases: most files create their own scratch database next to it.
- **Real LLM calls happen only in evaluations and in the dev CLI** (`npm run chat`). Both need
  `ANTHROPIC_API_KEY` and cost money.

## Commits and hooks

Commits follow [Conventional Commits](https://www.conventionalcommits.org/):

```text
type(scope): imperative subject in lower case

Optional body explaining why, wrapped at 100 characters.
```

- **Types:** `feat`, `fix`, `docs`, `test`, `refactor`, `perf`, `build`, `ci`, `chore`.
- **Scopes (optional):** `api`, `contracts`, `web`, `data`, `evals`, `infra`, `ci`, `docs`, `deps`.
- Keep commits small and atomic: one logical change each. The history should tell how the project
  was built.
- Do not start a body line with `word:`; commitlint parses such lines as footers.

Git hooks are managed by husky and installed by `npm ci`:

- **pre-commit** runs `lint-staged --no-revert --fail-on-changes`: `eslint --fix` and Prettier on
  staged files. It fails, instead of restaging, when a file changes while it runs, so run
  `npm run format` (or Prettier on your files) before committing and simply commit again.
- **commit-msg** runs commitlint with `@commitlint/config-conventional`.

If a hook fails, fix the cause and commit again. Do not bypass hooks with `--no-verify`.

## Adding an ADR

Write an Architecture Decision Record when a decision is hard to reverse, affects several parts of
the system, or is something an interviewer could ask "why?" about.

1. Copy [`docs/adr/0000-template.md`](docs/adr/0000-template.md) to
   `docs/adr/NNNN-kebab-case-title.md` with the next free number.
2. Fill in context, decision, consequences (including what we give up) and alternatives. Keep it
   short, and do not put unmeasured numbers in it: say which run will measure a claim.
3. Set the status to `Proposed`, then `Accepted` once the change that implements it is merged.
4. Add it to the index in [`docs/adr/README.md`](docs/adr/README.md).
5. Never rewrite an accepted ADR. Write a new one that supersedes it and update both statuses.

Commit it with the change it describes, for example `docs(adr): record the hosting decision`.

## Pull requests

- Lint, typecheck, unit and integration tests, build and the security scans must pass in CI.
- Pull requests that touch the agent must keep the evaluation's hard gates green.
- Describe what changed and why, and how you verified it (the template asks for it).

By contributing, you agree that your contributions are licensed under the [MIT License](LICENSE).
