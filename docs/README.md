# Documentation

Project documentation beyond the root [README](../README.md). Each document says what is measured
and what is still pending; nothing describes a run, a trace or a deployment that did not happen.

| Document                                   | Content                                                                                                                                                                            | Status                                                                                            |
| ------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------- |
| [`adr/`](adr/README.md)                    | Architecture Decision Records 0001 to 0013: one decision per file, with trade-offs and rejected alternatives.                                                                      | 13 accepted; 0014 (hosting) planned for the deployment                                            |
| [`EVALUATIONS.md`](EVALUATIONS.md)         | Evaluation methodology (retrieval, agent, LLM judge, calibration), gates, CI, and the results written by the runners.                                                              | Retrieval results measured; keyless controls passing; agent results and calibration pending a key |
| [`OBSERVABILITY.md`](OBSERVABILITY.md)     | What is traced and why, the metrics and the SQL behind them, a regression-diagnosis playbook, real development incidents and known gaps.                                           | Written; Langfuse dashboards and the trace-based case pending the first real traces               |
| [`DEPLOYMENT.md`](DEPLOYMENT.md)           | Fly.io + Neon: topology, secrets, first deploy, migrations, seeding, rollback, costs, monitoring, teardown.                                                                        | Prepared; first deploy pending accounts                                                           |
| [`INTERVIEW_NOTES.md`](INTERVIEW_NOTES.md) | Interview preparation, in French: the architecture explained simply, the path of one request, every trade-off, limits, and 35 questions with answers.                              | Written                                                                                           |
| [`LEARNING.md`](LEARNING.md)               | Learning kit, in French: guides to the agent loop, chunking with RRF and the evaluation metrics, and exercise branches (`learning/*`) whose unchanged tests are the specification. | Written; branches local, not pushed                                                               |
| [`HANDOFF.md`](HANDOFF.md)                 | State of the project on 2026-10-11: what is verified and how, what is not, and the next steps in order.                                                                            | Written                                                                                           |

Related files at the repository root and elsewhere:

- [`SECURITY.md`](../SECURITY.md): vulnerability reporting, security model, data handling and
  retention.
- [`CONTRIBUTING.md`](../CONTRIBUTING.md): setup, scripts and make targets, the Windows note,
  evaluations locally and in CI, testing policy, commits and the ADR process.
- [`data/README.md`](../data/README.md): corpus format, extraction rules, regeneration, licensing
  and known limitations.
- [`data/corpus/ATTRIBUTION.md`](../data/corpus/ATTRIBUTION.md): per-article provenance and licence
  of the travel corpus (generated).

## Conventions

- English, except `INTERVIEW_NOTES.md` and the learning kit (`LEARNING.md`, `learning/`), written in French for the project owner.
- Numbers come from running code. Evaluation results are written by the runners between markers in
  `EVALUATIONS.md`; the methodology around them is written by hand. What is not measured yet is
  marked pending, never filled with a placeholder figure.
- Diagrams use Mermaid so they render on GitHub and stay diffable.
