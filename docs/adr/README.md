# Architecture Decision Records

Each ADR records one significant decision: its context, what we chose, what we give up and the
alternatives we rejected. ADRs are written **at the milestone where the decision is made**, so the
Git history shows how the project was built. To write a new one, follow
[the template](0000-template.md) and the steps in [CONTRIBUTING.md](../../CONTRIBUTING.md#adding-an-adr).

## Index

| ADR                                                        | Title                                                               | Status   | Milestone |
| ---------------------------------------------------------- | ------------------------------------------------------------------- | -------- | --------- |
| [0000](0000-template.md)                                   | Template                                                            | —        | —         |
| [0001](0001-monorepo-and-stack.md)                         | npm workspaces monorepo and core TypeScript stack                   | Accepted | 1         |
| [0002](0002-layered-architecture-and-ports.md)             | Layered architecture with ports and adapters                        | Accepted | 1         |
| [0006](0006-hand-written-agent-runtime.md)                 | Hand-written agent runtime with terminal tools                      | Accepted | 3         |
| [0007](0007-llm-provider-abstraction-and-opaque-blocks.md) | LLM provider abstraction with opaque provider blocks                | Accepted | 3         |
| [0008](0008-observability-with-langfuse.md)                | Observability with Langfuse behind a `Tracer` port                  | Accepted | 3         |
| [0009](0009-structured-output-through-terminal-tools.md)   | Structured output through strict terminal tools, Zod and one repair | Accepted | 4         |
| [0010](0010-layered-guardrails.md)                         | Layered guardrails, capability limitation first                     | Accepted | 4         |
| [0011](0011-cost-control-and-rate-limiting.md)             | Cost control with a daily cap, a per-run ceiling and per-IP limits  | Accepted | 4         |

## Planned

These decisions are scheduled in the project plan. Each file appears when its milestone starts; the
titles may change.

| ADR  | Topic                                        | Milestone |
| ---- | -------------------------------------------- | --------- |
| 0003 | Corpus source and chunking strategy          | 2         |
| 0004 | Local embeddings behind an `Embedder` port   | 2         |
| 0005 | Hybrid retrieval with Reciprocal Rank Fusion | 2         |
| 0012 | Evaluation strategy and CI gates             | 5         |
| 0013 | LLM-as-judge and its calibration             | 5         |
| 0014 | Hosting                                      | 7         |
