# ADR 0012: Offline agent evaluation with atomic scorers and hard and soft CI gates

- **Status:** Accepted
- **Date:** 2026-10-10
- **Milestone:** 5

## Context

The agent's behaviour depends on a model we cannot make deterministic (no `temperature` on the
5.5 models), on a prompt, on tools and on guardrails that change with every pull request. Unit
tests prove the code paths with a scripted model; they say nothing about what the real model does
with them. We need a measurement that catches regressions before merge, runs in CI, costs little,
and that we can defend: an evaluation whose numbers can be traced back to transcripts, and whose
failures cannot be blamed on the harness.

## Decision

An offline evaluation of the agent in `evals/` (plan section 8), run by
`npm run eval:agent -w @wanderly/evals` and gated in CI (`.github/workflows/eval.yml`):

1. **A versioned dataset** of 45 cases in English and French (`evals/datasets/agent-cases.yaml`)
   over seven categories, including the "both directions" pairs (clear requests must not get a
   needless question; ambiguous ones must) and a grounding test (real places outside the corpus
   must be declined). Expectations come from the corpus and are checked against it by the loader;
   every case records its provenance (proposed by the agent, pending human review).
2. **The production entry point.** Each (case, rep) runs `runAgent` with the production prompt,
   tools, guardrails, model adapter and limits (shared factories in
   `services/api/src/composition/agent-deps.ts`), over the production Postgres retriever.
3. **Atomic deterministic scorers**, one metric per property (response type, schema validity,
   citation integrity and grounded numbers recomputed from the raw trajectory, constraint fit,
   clarification in both directions, guardrails, canary leaks, tool errors, cost, latency), and an
   LLM judge only for what rules cannot see (ADR 0013).
4. **Harness hygiene by construction** (the claude-api eval audit checklist): fresh ports per
   attempt, a hard per-case wall clock, a served-model assertion on every call, bounded retries
   with full-jitter backoff recorded per row, infrastructure failures in `errors.jsonl` and never
   scored, truncations and refusals as their own statuses, full trajectories per case, `--reps`
   with bootstrap intervals over cases, and a whole-run dollar cap.
5. **Controls before any paid run**: an oracle policy that must score 100 % and two null
   baselines (constant decline, empty answers) that must score low, all through the real loop and
   in CI without a key.
6. **Two kinds of gates** (`evals/thresholds.json`). Hard gates on near-deterministic invariants
   (schema valid after repair = 100 %, zero canary leaks, citation integrity ≥ 95 %, at least
   90 % of attempts scored) fail the build on any regression. Soft gates on quality metrics are
   set to the first measured baseline minus a margin from its noise floor; until that run exists
   they are `null` and reported as pending, never invented.

## Consequences

### Positive

- A regression in grounding, safety or the output contract fails the PR before merge, with the
  transcript that shows why.
- Every number in the report recomputes from `results.jsonl`, and the controls prove the scorers
  are wired before money is spent.
- Comparing models (Haiku vs Sonnet) or prompts is one flag, with paired intervals.

### Negative

- With 45 cases and one rep, a pass rate carries a noise floor of about ±15 points (1/√45): soft
  gates can only catch large regressions, and small differences between variants are not
  established without more reps or cases.
- The dataset was written by the build agent; until a human reviews it (and adds cases), it is a
  development signal with the biases of its author.
- Each real run costs money (bounded by `--max-usd`), and fork PRs never run it (no secrets).
- Real retrieval needs Linux (the ONNX runtime crashes on the Windows development host, ADR 0004).

### Follow-ups

- First real baseline: run with the key, review the transcripts, then set the soft gates from
  the proposed thresholds in `summary.json` (with `--reps 3` to measure the real variance).
- Human review of the dataset; add production failure modes as cases.

## Alternatives considered

- **A framework (promptfoo, DeepEval, Langfuse datasets):** faster to start, but it would
  re-implement the model call instead of exercising our runtime, guardrails and repair loop, and
  hide the harness decisions this project is meant to show.
- **One global quality score:** easier to read, impossible to diagnose; atomic metrics tell which
  property moved.
- **Thresholds chosen up front:** they would be invented. Measuring first and deriving the margin
  from the noise floor is the only defensible order.
- **Running the paid evaluation on every push:** more signal, more cost and secret exposure; PRs
  touching the code paths and manual dispatch are enough at this scale.
