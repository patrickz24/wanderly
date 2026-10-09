# ADR 0002: Layered architecture with ports and adapters in the API

- **Status:** Accepted
- **Date:** 2026-10-09
- **Milestone:** 1

## Context

The API's core is an agent loop that calls an external, non-deterministic LLM, a hybrid retriever
on Postgres, a local embedding model and a tracing backend. We need to:

- **Unit test the agent loop** (step limits, tool failures, timeouts, invalid output, repair) in
  milliseconds, with a fake LLM and no database or network.
- **Evaluate exactly what we deploy**: the eval runner must call the same use case as production,
  with the same prompt, tools and model, not a reimplementation.
- **Swap infrastructure cheaply**: a hosted embedder is the plan B if the local one uses too much
  memory (milestone 2), tracing must become a no-op without Langfuse keys, and a second LLM
  provider is on the roadmap.
- **Keep the design explainable**: a reviewer should find where each concern lives without a
  framework-specific mental model.

## Decision

Split `services/api/src` into four layers with dependencies pointing inwards:

| Layer            | Contains                                                                                                                                                           | May depend on                                  |
| ---------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ---------------------------------------------- |
| `domain`         | Agent loop, tool definitions and their pure logic (such as the budget calculation), guardrails, pure RAG functions (chunker, rank fusion), and **port** interfaces | Itself and Zod only. No framework, SDK or I/O. |
| `application`    | Use cases (`SendMessage`, `IngestCorpus`, `SubmitFeedback`) that orchestrate the domain through ports                                                              | `domain`                                       |
| `infrastructure` | **Adapters** implementing the ports: Anthropic client, Postgres repositories and retriever, local ONNX embedder, Langfuse tracer and its no-op twin                | The ports it implements, SDKs, drivers         |
| `api`            | Fastify routes, plugins (errors, rate limit, cost cap, session) and SSE                                                                                            | `application`                                  |

- **Ports are owned by the domain** and phrased in domain terms: `LlmPort`, `Retriever`, `Embedder`,
  `Tracer`, repositories and `Clock`. Provider-specific data that must round-trip unchanged (such
  as thinking blocks) travels through the LLM port as opaque values; the provider abstraction gets
  its own ADR at milestone 3. Operational ports that the domain never uses, such as the readiness
  checks behind `GET /ready`, live in `application/ports` instead.
- **One composition root**: `src/main.ts` is the only module that reads validated config,
  instantiates adapters and wires them into use cases. `buildApp` in `src/app.ts` receives its
  dependencies, so tests build the HTTP app with fakes. No DI container: wiring is plain
  constructor and function arguments.
- **Boundaries are enforced by ESLint** (`no-restricted-imports` in the root `eslint.config.js`):
  - `domain` cannot import `application`, `infrastructure`, `api` or config modules, nor
    infrastructure packages (`fastify`, `@fastify/*`, `pg`, `pgvector`, `@anthropic-ai/*`,
    Langfuse, `@huggingface/*`, `@opentelemetry/*`), nor I/O modules (`node:fs`, `node:net`,
    `node:http*`, `node:child_process`);
  - `application` cannot import `infrastructure`, `api` or infrastructure packages.
  - The rule that `api` only talks to `application` is not lint-enforced yet; review covers it.

## Consequences

### Positive

- Domain and application tests run against in-memory fakes, with time injected through `Clock`,
  so deadlines and timeouts are tested deterministically and quickly.
- Adapters are covered by integration tests against a real Postgres
  (`services/api/test/integration`), and real LLM calls only happen in `evals/`.
- The eval runner calls the production use case, so it measures what we ship.
- Replacing the embedder, the tracer or the LLM provider touches one adapter and the composition
  root.
- Layer violations fail CI instead of relying on discipline.

### Negative (what we give up)

- **More indirection for a small service**: interfaces, adapters and wiring code add files and
  make "go to definition" land on an interface.
- **Mapping code** between database rows, provider payloads and domain types.
- **Ports can leak**: provider concepts (thinking blocks, cache tokens, refusal reasons) tend to
  creep into the domain. Opaque blocks contain this but do not remove it.
- **Zod inside the domain** is a deliberate dependency on a library: schemas are domain rules here,
  and the coupling is accepted.
- **Lint rules are path patterns**, not a module system. A creative re-export can slip through, so
  review still matters.

### Follow-ups

- Add a lint rule that restricts `services/api/src/api/**` to `application` and contracts.
- Write the provider abstraction ADR (milestone 3) before the Anthropic adapter grows.

## Alternatives considered

- **Classic layering without ports** (routes call services that call the SDK and `pg`): less code,
  but testing the loop requires mocking modules by path (brittle), and evals would have to stub at
  the network level.
- **Hexagonal architecture with a DI container** (InversifyJS, tsyringe) or **NestJS**: the same
  boundaries with more ceremony, decorators and reflection. A hand-written composition root is
  enough at this size and is easier to read.
- **Vertical feature slices** (one folder per feature with its own route, logic and SQL): good for
  wide applications with many independent features. Wanderly has one core flow, and layer
  boundaries are easier to enforce with lint. Slices remain an option inside each layer.
