# ADR 0001: npm workspaces monorepo and core TypeScript stack

- **Status:** Accepted
- **Date:** 2026-10-09
- **Milestone:** 1

## Context

Wanderly has four parts that must agree on the same data shapes: an API (agent loop, RAG,
guardrails), a React client, an offline evaluation pipeline and the contracts shared between them.
It is a single-maintainer portfolio project, so the constraints are:

- **One language end to end**, so API, web and evals share Zod schemas and types.
- **Explainable choices**: every dependency must be defensible in an interview. Quality and clarity
  beat feature count.
- **No global tooling** beyond Node.js and Docker: `docker compose up` and `npm run eval` must just
  work.
- **The SQL is part of the product**: retrieval relies on PostgreSQL-specific features (pgvector
  operators, `tsvector`, CTEs) that the project sets out to show and tune.
- **Small scale**: four workspaces, one HTTP service, one maintainer.

## Decision

| Concern            | Choice                                                                                                                                  | Main reason                                                            |
| ------------------ | --------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------- |
| Repository         | **npm workspaces** (`packages/contracts`, `services/api`, `apps/web`, `evals`), ESM everywhere                                          | No extra tool: npm ships with Node.                                    |
| Language           | **TypeScript strict** (`strict`, `noUncheckedIndexedAccess`, `noImplicitOverride`, `verbatimModuleSyntax`) + typescript-eslint `strict` | Unsafe code (`any`, non-null assertions) is a lint error, not a habit. |
| Runtime            | **Node.js 22 as the supported floor** (`engines`, `.nvmrc`, Docker and CI images)                                                       | Oldest LTS line still supported today; CI tests the floor we claim.    |
| HTTP               | **Fastify 5** + `fastify-type-provider-zod`, official `helmet`, `cors`, `rate-limit` and `cookie` plugins                               | Runtime validation and handler types come from one Zod schema.         |
| Schemas            | **Zod 4** at every trust boundary: env config, HTTP, shared contracts, tool inputs, corpus files, LLM output                            | One validation language everywhere.                                    |
| Database access    | **`pg` + hand-written SQL**, plain SQL migrations with `node-pg-migrate`                                                                | The retrieval SQL is the feature; nothing should hide it.              |
| Tests              | **Vitest** for unit, integration and React (jsdom + Testing Library) tests                                                              | Native ESM and TypeScript, one runner for every workspace.             |
| Web                | **React 19 + Vite + Tailwind 4**, hand-written SSE hook, no data-fetching library                                                       | Standard and fast; the client state is a single conversation.          |
| Repository hygiene | Prettier, ESLint flat config, husky + lint-staged + commitlint (Conventional Commits)                                                   | Rules are enforced by tools, not by memory.                            |

`packages/contracts` exposes a `development` export condition that points at its TypeScript
sources, so Vite, Vitest and `tsx --conditions=development` need no build step. Production
consumers use the compiled `dist/`, so contracts must be built before the API and the web app;
`npm run build` follows the workspace declaration order, which lists contracts first.

## Consequences

### Positive

- A newcomer needs `npm ci` and `npm run <script>`, nothing else installed globally.
- Changing a schema in `packages/contracts` breaks the API and web typechecks at the same time.
- Route schemas are written once and give both validation and types.
- Retrieval SQL is visible, reviewable and tunable with `EXPLAIN`; migrations are readable SQL.
- Web tests reuse the Vite transform pipeline through Vitest.

### Negative (what we give up)

- **No task graph or build cache.** Unlike Turborepo or Nx, builds are not cached and run in
  declaration order; we must keep contracts first. Acceptable at four workspaces.
- **Weaker dependency isolation than pnpm.** npm hoists packages, so a workspace can import a
  dependency it does not declare. Today only review catches it.
- **No generated database types.** Rows are mapped by hand at the repository boundary. Drift between
  SQL and TypeScript is caught by integration tests against a real Postgres, not by the compiler,
  and plain CRUD needs more boilerplate. Migrations are hand-written, with no schema diffing.
- **Fastify is less familiar than Express**, and its encapsulation model takes time to learn.
  `fastify-type-provider-zod` is a community package, so major Fastify or Zod upgrades depend on it.
- **Zod is slower than compiled JSON Schema validators** (Ajv, TypeBox). Irrelevant at demo traffic,
  where the LLM call dominates latency. Strict tool definitions accept only a subset of JSON Schema,
  so the Zod-to-JSON-Schema conversion of tool inputs needs its own tests (milestone 3).
- **Strict TypeScript is slower to write**: `noUncheckedIndexedAccess` makes every indexed access
  possibly `undefined` and forces explicit narrowing.
- **Node 22 is in maintenance LTS** and reaches end of life in April 2027. We cannot use APIs newer
  than Node 22, and the floor must move to Node 24 before that date.
- **No server-side rendering.** Fine for a chat client behind a demo; SEO is not a goal.

### Follow-ups

- Raise the Node.js floor to 24 before Node 22 reaches end of life.
- Adopt a task runner only if measured CI build time becomes a real problem.
- Consider a lint rule against undeclared dependencies if a phantom import ever slips through.

## Alternatives considered

- **pnpm workspaces:** strict isolation, faster installs, less disk. Not chosen: one more tool to
  install and explain, for a benefit that is small at four workspaces.
- **Turborepo or Nx:** cached, graph-aware task runs. Not chosen: they solve a scale problem this
  repository does not have, at the cost of extra configuration and concepts.
- **Express 5:** the most familiar option. Not chosen: no built-in schema validation or typed
  routes; we would assemble validation, typing and security middleware ourselves.
- **NestJS:** batteries included. Not chosen: decorators and a DI container hide the explicit
  composition root that [ADR 0002](0002-layered-architecture-and-ports.md) relies on, and it is
  heavy for one service.
- **Hono:** strong typing and multi-runtime support. Not chosen: we only target Node.js, and
  Fastify's official plugins already cover our security needs.
- **Prisma, Drizzle or Kysely:** typed database access. Not chosen for now: the core retrieval
  queries (vector distance, `websearch_to_tsquery`, rank fusion CTEs) would stay raw SQL anyway.
  Drizzle and Kysely are the closest contenders and the first candidates if plain CRUD grows.
- **TypeBox + Ajv:** native JSON Schema and faster validation, idiomatic in Fastify. Not chosen:
  Zod is more ergonomic for types shared with the web app and for parsing LLM output, and one
  schema language beats two.
- **Jest or `node:test`:** Jest needs extra transform configuration for native ESM and TypeScript;
  `node:test` has no jsdom or React integration and weaker mocking and coverage ergonomics.
- **Next.js:** routing and SSR we do not need. A static Vite build served by nginx is simpler to
  containerise and to put behind the same-origin API proxy.
