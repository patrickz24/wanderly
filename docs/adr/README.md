# Architecture Decision Records

Each ADR records one significant decision: its context, what we chose, what we give up and the
alternatives we rejected. ADRs are written **at the milestone where the decision is made**, so the
Git history shows how the project was built. An accepted ADR is never rewritten: a later decision
supersedes it in a new file. To write a new one, follow [the template](0000-template.md) and the
steps in [CONTRIBUTING.md](../../CONTRIBUTING.md#adding-an-adr).

## Index

| ADR                                                        | Title                                                                   | Topic         | Status   | Milestone |
| ---------------------------------------------------------- | ----------------------------------------------------------------------- | ------------- | -------- | --------- |
| [0000](0000-template.md)                                   | Template                                                                | —             | —        | —         |
| [0001](0001-monorepo-and-stack.md)                         | npm workspaces monorepo and core TypeScript stack                       | Foundation    | Accepted | 1         |
| [0002](0002-layered-architecture-and-ports.md)             | Layered architecture with ports and adapters                            | Foundation    | Accepted | 1         |
| [0003](0003-corpus-and-structure-aware-chunking.md)        | Wikivoyage corpus and structure-aware chunking                          | Retrieval     | Accepted | 2         |
| [0004](0004-local-embeddings.md)                           | Local embeddings with bge-small-en-v1.5 behind the `Embedder` port      | Retrieval     | Accepted | 2         |
| [0005](0005-hybrid-retrieval-with-rrf.md)                  | Hybrid retrieval with Reciprocal Rank Fusion in Postgres                | Retrieval     | Accepted | 2         |
| [0006](0006-hand-written-agent-runtime.md)                 | Hand-written agent runtime with terminal tools                          | Agent         | Accepted | 3         |
| [0007](0007-llm-provider-abstraction-and-opaque-blocks.md) | LLM provider abstraction with opaque provider blocks                    | Agent         | Accepted | 3         |
| [0008](0008-observability-with-langfuse.md)                | Observability with Langfuse behind a `Tracer` port                      | Observability | Accepted | 3         |
| [0009](0009-structured-output-through-terminal-tools.md)   | Structured output through strict terminal tools, Zod and one repair     | Agent         | Accepted | 4         |
| [0010](0010-layered-guardrails.md)                         | Layered guardrails, capability limitation first                         | Safety        | Accepted | 4         |
| [0011](0011-cost-control-and-rate-limiting.md)             | Cost control with a daily cap, a per-run ceiling and per-IP limits      | Safety        | Accepted | 4         |
| [0012](0012-evaluation-strategy-and-ci-gates.md)           | Offline agent evaluation with atomic scorers and hard and soft CI gates | Evaluation    | Accepted | 5         |
| [0013](0013-llm-as-judge-and-calibration.md)               | LLM-as-judge for faithfulness and request fit, with documented limits   | Evaluation    | Accepted | 5         |

## Planned

This decision is scheduled in the project plan. Its file appears when its milestone starts; the
title may change.

| ADR  | Topic   | Milestone |
| ---- | ------- | --------- |
| 0014 | Hosting | 7         |

## Related documents

- [EVALUATIONS.md](../EVALUATIONS.md): the measurements behind ADRs 0003 to 0005, and the
  evaluation that ADRs 0012 and 0013 describe.
- [OBSERVABILITY.md](../OBSERVABILITY.md): what ADR 0008 traces in practice, and how to diagnose a
  regression with it.
- [INTERVIEW_NOTES.md](../INTERVIEW_NOTES.md) (French): every trade-off of these ADRs, explained
  for an interview.
