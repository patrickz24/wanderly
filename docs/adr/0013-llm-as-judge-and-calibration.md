# ADR 0013: LLM-as-judge for faithfulness and request fit, with documented limits

- **Status:** Accepted
- **Date:** 2026-10-10
- **Milestone:** 5

## Context

The deterministic scorers (ADR 0012) prove that every citation exists and every number matches a
tool output, but not that the prose is true to what was cited: an item can cite a real excerpt and
still claim an opening time the excerpt never states. Whether an itinerary fits the request
("quiet places", "with kids") is also beyond a rule. These properties need a reader. A model judge
is the practical reader, and a known-biased one.

## Decision

An LLM judge (`evals/judge/`) on itineraries and answers, with:

- **A different model from the agent**: `JUDGE_MODEL`, default `claude-sonnet-5-5`, while the agent
  defaults to `claude-haiku-5-5`; the runner refuses a judge equal to the agent model unless
  explicitly overridden.
- **Two properties, two calls**: faithfulness (every factual claim of the item descriptions and
  justifications, binary supported/unsupported against the context the agent retrieved in that
  run, plus the aggregate rate) and request fit (a 3-level rubric). Both rubrics are documented
  verbatim in `docs/EVALUATIONS.md`, and the prompts are versioned (`judge-v1`).
- **Untrusted input**: the candidate, the request and the retrieved context are delimited data
  with closing tags neutralized, and the judge is told never to follow instructions inside them
  (the context can contain the indirect-injection fixtures).
- **Structured output** (`output_config.format` JSON schema), Zod-validated; refusals, truncation,
  invalid output and a served-model mismatch are judge errors, never scores.
- **No length reward**: both rubrics say so explicitly; request fit writes its rationale before
  its score.
- **Known negatives** (empty, "I don't know", confident but unsupported) covered by unit tests
  through a fake judge, and an empty candidate fails without a model call.
- **Calibration** against human labels (`evals/datasets/judge-calibration.yaml`, about 25
  outputs, raw agreement and Cohen's kappa per property). Until it is filled, judge scores are a
  development signal only: they feed soft gates at most, never hard ones.

## Consequences

### Positive

- Faithfulness at the claim level catches hallucinated details that citation checks cannot see,
  and the per-claim list makes each verdict auditable.
- Judge cost is measured from API usage and reported apart from the agent's.

### Negative

- **Self-preference**: the judge and the agent are both Claude models; a different family was not
  an option on this stack. A different model and tier limits, but does not remove, the bias.
- **Verbosity and leniency biases** are mitigated by the rubric, not measured until calibration.
- **Uncalibrated until a human labels outputs**: agreement and kappa are unknown today.
- Judge variance adds to model variance; a judge run twice on the same output may disagree.
- Each judged output costs two calls of a larger model than the agent's.

### Follow-ups

- Label the calibration set, publish agreement and kappa; iterate on the rubric if agreement on
  clear-cut items is well below 90 %.
- Measure judge variance by grading the same outputs twice.

## Alternatives considered

- **Reference-based similarity (BLEU, embeddings) against gold itineraries:** rewards imitating
  one plan when many plans are valid, and gold plans would have to be written by a model.
- **A single holistic "quality" grade:** cheaper, but not diagnosable and more prone to verbosity
  bias.
- **Pairwise comparison against a baseline output:** useful to compare variants, but needs
  position randomization and a frozen reference; deferred until variants are compared routinely.
- **No judge, deterministic checks only:** cheaper and deterministic, but blind to unsupported
  prose, which is the hallucination this project most needs to catch.
