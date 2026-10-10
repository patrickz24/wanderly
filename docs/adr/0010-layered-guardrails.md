# ADR 0010: Layered guardrails, capability limitation first

- **Status:** Accepted
- **Date:** 2026-10-10
- **Milestone:** 4

## Context

Wanderly is a public demo: anyone can type anything, and the agent reads third-party guide text
that could contain instructions (indirect prompt injection). No single defence against prompt
injection is reliable, so we combine layers and make each one testable, starting with the one
that bounds the damage when the others fail.

## Decision

Guardrails in layers, each with tests (plan §7):

1. **Capability limitation (strongest).** Every tool is read-only over our own database: no
   writes, no network, no side effects. A successful injection can at worst produce a wrong
   answer, never an action. Tool arguments are validated (Zod, catalog ids), and failures go back
   to the model as data.
2. **Input.** Message length (contracts), a turn cap and a daily budget cap (use case), and
   per-IP rate limiting (HTTP layer). Prompt-injection heuristics (`guardrails/injection.ts`) run
   on the user text and on tool outputs and produce **signals only** (`user:…` and `tool:…`),
   reported in the run result and traces, never a block.
3. **Prompt.** Instructions and data are separated: the system prompt says tool results and guide
   excerpts are data, never instructions; the application's context block and the user's words
   are separate blocks; the rules "hold for the whole conversation" (the provider's recommended
   wording); a **canary token** sits in the system prompt.
4. **Output.** Schema, consistency and grounding checks
   ([ADR 0009](0009-structured-output-through-terminal-tools.md)); a **canary check** on every
   text field of the response: a leak replaces the response by a
   `decline` (`unsafe`), closes the call with an explanation for the model, and sets
   `signals.canaryLeak`. A provider `refusal` becomes a `decline` too (`signals.providerRefusal`).
5. **Run limits.** Steps, deadlines and a per-run cost ceiling bound what a manipulated
   conversation can consume ([ADR 0006](0006-hand-written-agent-runtime.md)).
6. **Indirect injection** is tested by the evaluation with a trapped document that exists only in
   the eval fixtures (milestone 5).

## Consequences

### Positive

- The blast radius of a successful injection is a bad text, which the output checks then
  constrain (no invented citations, no foreign destinations, no leaked canary).
- Signals make attacks visible in traces and evals without blocking legitimate users.
- Each layer is a small pure function with unit tests.

### Negative

- Regex heuristics are easy to evade (paraphrase, other languages, encodings) and can flag
  innocent text; that is why they never block.
- The canary only detects verbatim leaks (case and separators ignored), not a paraphrase of the
  instructions.
- The eval must read `signals.canaryLeak`: a blocked leak looks like a correct `decline` to the
  user but is a model failure.
- No dedicated classifier call: cheaper and simpler, but weaker against novel attacks.

### Follow-ups

- Add an input classifier only if the evaluation's injection cases show that layers 1 to 5 are
  not enough: a data-driven decision.
- Report injection and canary signals as trace scores in the use case.

## Alternatives considered

- **Blocking on heuristics:** gives a false sense of safety and frustrates legitimate users.
- **A second LLM as input or output classifier:** more robust, but doubles cost and latency; kept
  for later, if measured necessary.
- **Relying on the system prompt alone:** prompts reduce but do not prevent injection; without
  capability limits and output checks, one success could do anything a tool allows.
