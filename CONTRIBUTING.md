# Contributing to Wanderly

Wanderly is a personal portfolio project built milestone by milestone. Issues, questions and
evaluation case ideas are very welcome. Pull requests are read, but may not be merged if they
conflict with the plan or with parts the author is implementing to learn. For security problems,
follow [SECURITY.md](SECURITY.md) instead of opening an issue.

## Prerequisites

- **Node.js 22 or newer** (the version in `.nvmrc` is the supported floor and the one CI uses).
- **npm**, bundled with Node.js. No pnpm, Yarn or global tools are needed.
- **Docker** with the Compose plugin (`docker compose`), for Postgres and the full stack.
- **Git**. Hooks are installed automatically by `npm ci`.

## Getting started

```bash
npm ci                    # installs dependencies and the Git hooks
cp .env.example .env      # then set at least SESSION_SECRET
set -a; . ./.env; set +a  # export the variables into this shell (Bash or Git Bash)
docker compose up -d db   # Postgres 16 + pgvector on localhost:5432
npm run migrate           # applies SQL migrations to DATABASE_URL
npm run dev:api           # API on http://localhost:3000
npm run dev:web           # web client on http://localhost:5173, proxies /api to the API
```

With `make` (Git Bash or WSL on Windows), `make env` creates `.env` with a random session secret
and `make dev` runs the steps above.

The API and the migration tool read their configuration from environment variables; the API
validates it with Zod at startup and lists every invalid variable by name, never by value.
`.env.example` documents each variable. `DATABASE_URL` and `SESSION_SECRET` are required; variables
for later milestones (Anthropic, Langfuse) stay optional until their milestone.

## Workspace layout

| Path                 | Package               | What lives there                                                                   |
| -------------------- | --------------------- | ---------------------------------------------------------------------------------- |
| `packages/contracts` | `@wanderly/contracts` | Shared Zod schemas and types: API payloads, SSE events, agent responses.           |
| `services/api`       | `@wanderly/api`       | Fastify API: `src/{domain,application,infrastructure,api}`, SQL migrations, tests. |
| `apps/web`           | `@wanderly/web`       | React + Vite + Tailwind client.                                                    |
| `evals`              | `@wanderly/evals`     | Offline evaluation pipeline (filled at milestones 2 and 5).                        |
| `data/`              | none                  | Travel corpus and its generation scripts, see [`data/README.md`](data/README.md).  |
| `docs/`              | none                  | Architecture Decision Records and project documentation.                           |

Every workspace is ESM (`"type": "module"`). In development, `@wanderly/contracts` resolves to its
TypeScript sources through a `development` export condition, so no build step is needed. Production
builds use its compiled `dist/`, which `npm run build` produces first.

## Scripts

Run from the repository root:

| Script                     | What it does                                                                |
| -------------------------- | --------------------------------------------------------------------------- |
| `npm run lint`             | ESLint on the whole repository, including the layering rules.               |
| `npm run format`           | Prettier, writing changes.                                                  |
| `npm run format:check`     | Prettier, checking only (used in CI).                                       |
| `npm run typecheck`        | `tsc --noEmit` in every workspace.                                          |
| `npm test`                 | Unit tests (Vitest) in every workspace. No database, no network.            |
| `npm run test:integration` | API integration tests against a real Postgres (`DATABASE_URL` must be set). |
| `npm run build`            | Builds every workspace, contracts first.                                    |
| `npm run dev:api`          | API in watch mode.                                                          |
| `npm run dev:web`          | Vite dev server.                                                            |
| `npm run migrate`          | Applies pending SQL migrations.                                             |

To target one workspace, add `-w`, for example `npm run test:coverage -w @wanderly/api`.
`npm run eval` arrives at milestone 5. The data scripts are not a workspace: run them with
`npx tsx data/scripts/<script>.ts` and their tests with `npx vitest run --root data`.

The `Makefile` wraps the common commands (`make up`, `make dev`, `make test`, `make lint`…);
`make help` lists them, and its header gives the npm or Docker equivalent of each target.

## Code style

- TypeScript strict, no `any` (use `unknown` and parse with Zod), no non-null assertions outside
  tests. These are lint errors, not suggestions.
- Small pure functions, explicit errors, no hidden I/O.
- Prettier owns formatting; do not hand-format.
- Never invent numbers (benchmarks, evaluation results, prices) in code or docs. Anything measured
  must come from running code; unknown values stay `null` with a note, or a clearly marked TODO.

## Layering rules

The API follows the layered design in
[ADR 0002](docs/adr/0002-layered-architecture-and-ports.md). ESLint (`no-restricted-imports` in
`eslint.config.js`) fails the build when a file breaks a boundary:

| Layer                | Must not import                                                                                                                                                                                                                 |
| -------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `src/domain/**`      | `application`, `infrastructure`, `api`, config modules; `fastify`, `@fastify/*`, `pg`, `pgvector`, `@anthropic-ai/*`, Langfuse, `@huggingface/*`, `@opentelemetry/*`; `node:fs`, `node:net`, `node:http*`, `node:child_process` |
| `src/application/**` | `infrastructure`, `api`, and the same infrastructure packages                                                                                                                                                                   |

`src/api` should only call `application`; that rule is checked in review for now. Adapters are
created and wired in one place, the composition root `services/api/src/main.ts`.

## Testing policy

- **Every behaviour change comes with a test.** Unit tests are co-located as `*.test.ts(x)`.
- **Unit tests never call a real LLM or the network.** The agent is tested with a fake LLM that
  implements the `LlmPort`, and other ports with in-memory fakes. Inject time through the `Clock`
  port instead of using real timers.
- **Unit tests never assert on free text written by a model.** Assert on structure, tool calls and
  validation results.
- **Database code is tested against a real Postgres** in `services/api/test/integration/*.int.test.ts`
  (`npm run test:integration`), not with a mocked driver.
- **Real LLM calls happen only in evaluations** (`evals/`, `npm run eval`, milestone 5). They need
  `ANTHROPIC_API_KEY` and cost money. In CI, the agent evaluation runs only on pull requests that
  touch `services/`, `packages/` or `evals/`, and is skipped on forks, which have no secrets.

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

- **pre-commit** runs lint-staged: `eslint --fix` and Prettier on staged files.
- **commit-msg** runs commitlint with `@commitlint/config-conventional`.

If a hook fails, fix the cause and commit again. Do not bypass hooks with `--no-verify`.

## Adding an ADR

Write an Architecture Decision Record when a decision is hard to reverse, affects several parts of
the system, or is something an interviewer could ask "why?" about.

1. Copy [`docs/adr/0000-template.md`](docs/adr/0000-template.md) to
   `docs/adr/NNNN-kebab-case-title.md` with the next free number.
2. Fill in context, decision, consequences (including what we give up) and alternatives. Keep it
   short, and do not put unmeasured numbers in it.
3. Set the status to `Proposed`, then `Accepted` once the change that implements it is merged.
4. Add it to the index in [`docs/adr/README.md`](docs/adr/README.md).
5. Never rewrite an accepted ADR. Write a new one that supersedes it and update both statuses.

Commit it with the change it describes, for example `docs: add ADR 0005 on hybrid retrieval`.

## Pull requests

- Lint, typecheck, unit tests, build and the security scans must pass in CI.
- From milestone 5, pull requests that touch the agent must not break the evaluation thresholds.
- Describe what changed and why, and how you verified it.

By contributing, you agree that your contributions are licensed under the [MIT License](LICENSE).
