# ADR 0009: Structured output through strict terminal tools, Zod and one repair

- **Status:** Accepted
- **Date:** 2026-10-10
- **Milestone:** 4

## Context

The UI renders an `AgentResponse` (`packages/contracts/src/agent.ts`): an itinerary, a
clarification, an answer or a decline. Nothing may reach the user unvalidated, and "valid
according to the schema" is not "correct": the itinerary must have the requested number of days,
its places and citations must come from this run's tool results, and its budget must be the one
the budget tool computed.

Constraints of the API (claude-api skill, checked 2026-10-09/10):

- forced `tool_choice` (`any`/`tool`) is rejected on Sonnet and Opus 5.5, so the model cannot be
  forced to call a "respond" tool;
- strict tool use (`strict: true`) guarantees schema-valid arguments, but accepts only a subset of
  JSON Schema (no numeric bounds, string lengths, `maxItems`; `minItems` 0 or 1 only;
  `additionalProperties: false` everywhere) and caps a request at 20 strict tools, 24 optional
  parameters and 16 union-typed parameters.

## Decision

1. **One terminal tool per response variant** (`present_itinerary`, `ask_clarification`,
   `answer_question`, `decline`), whose input is the variant without `type`. Choosing the tool is
   choosing the response type. The prompt says to end every turn with one of them, alone.
2. **Strict schemas generated from the contracts' Zod schemas** (`strict-json-schema.ts`): objects
   closed, every property required (nullable instead of optional), unsupported constraints moved
   into the description, small integer ranges and nullable enums turned into enums (`null`
   inside the enum), which the provider enforces without spending the union budget. A startup
   guard and a test reject a tool set over the limits; today all eight tools are strict.
3. **Zod validation** with the original schemas (lengths, ranges, counts the wire schema cannot
   express).
4. **Semantic validation** (`guardrails/`): consistency (days = `durationDays`, numbered in order,
   catalog destination, brief agreeing with the itinerary) and grounding against a per-run
   **evidence registry** filled by the data tools: every `sourceRef` and `poiId` was returned in
   this run and belongs to the destination, the budget equals the `estimate_budget` result it
   cites (same figures, currency, days and travellers), the weather month matches.
5. **One repair.** An invalid terminal call gets an `is_error` tool result listing the issues
   ("rejected and NOT shown to the user"); a second invalid call fails the run with
   `INVALID_OUTPUT`. Plain text gets one reminder. The run reports `validFirstTry` and `repairs`.

## Consequences

### Positive

- The shape is guaranteed by the provider, the content by our checks; a response the UI receives
  has passed both.
- Issues are phrased for the model, so repairs are targeted; `validFirstTry` and `repairs` feed
  the evaluation (schema valid first try, valid after repair).
- The terminal-tool contract works the same on Haiku, Sonnet and Opus.

### Negative

- A repair costs one more model call; a second failure is an error the user sees.
- Evidence is per run: on a follow-up turn the model must call the tools again to cite them,
  which costs a step but keeps "cited = seen in this run" checkable.
- The strict budget constrains schema growth (the union count is close to its limit); new
  nullable fields may need the enum trick, a non-strict tool or a schema change.
- The enum-with-`null` encoding relies on the documented enum support; it is not yet verified
  against the real API (no key on the development machine yet).

### Follow-ups

- Measure first-try validity and repair rates per model in the evaluation (milestone 5).
- Verify the strict schemas with one real request per tool before the first deployment.

## Alternatives considered

- **`output_config.format` (JSON outputs):** constrains the final message only and does not
  combine as naturally with a tool loop; the provider notes the model may skip a needed tool
  call when a JSON format is requested with thinking off.
- **One `respond` tool with a union of the four variants:** one more union parameter, and a less
  clear choice for the model than four named tools.
- **Free text parsed afterwards:** no schema guarantee, brittle parsing, and nothing to repair
  against.
- **Retrying until valid:** unbounded cost; one repair keeps the worst case predictable.
