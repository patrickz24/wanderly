# ADR 0006: Hand-written agent runtime with terminal tools

- **Status:** Accepted
- **Date:** 2026-10-10
- **Milestone:** 3

## Context

The agent answers a travel request by calling read-only tools (guide search, climate, budget,
points of interest) and must end with a typed response the UI can render. The runtime has to:

- be **unit-testable** with a scripted fake model, in milliseconds, for every failure path
  (tool error, tool timeout, model timeout, provider outage, invalid output, step limit, cost
  ceiling, refusal);
- keep the conversation **append-only** and replay the provider's reasoning blocks verbatim (see
  [ADR 0007](0007-llm-provider-abstraction-and-opaque-blocks.md));
- validate the final output (schema, business rules, citations) and repair it once
  ([ADR 0009](0009-structured-output-through-terminal-tools.md));
- enforce our own limits: the SDK retries timeouts, so a call can last several times its
  timeout, and the knowledge ports take no `AbortSignal`;
- be explainable line by line in an interview.

## Decision

Write the tool-calling loop by hand, in the domain (`services/api/src/domain/agent/run-agent.ts`),
against the provider-neutral `LlmPort`. No orchestration framework and no SDK tool runner.

- **Terminal tools.** Every turn must end with exactly one call to `present_itinerary`,
  `ask_clarification`, `answer_question` or `decline`; their arguments are the response. Plain
  text gets one reminder, then the run fails with `INVALID_OUTPUT`.
- **Steps.** Call the model; refused output becomes a `decline` (`unsafe`); output cut at
  `max_tokens` fails as truncated; data tool calls run **in parallel** and all their results go
  back in **one** user message; an invalid terminal call gets **one repair** round with its issues
  as an `is_error` result.
- **Recoverable tool failures.** Unknown tool, invalid arguments, unknown destination, port error
  and timeout all become `is_error` results; internal error details go to the trace, not to the
  model.
- **Limits.** Steps, per-call and per-tool deadlines raced against a run deadline
  (`withDeadline`: it settles even if the task ignores its signal), and a per-run cost ceiling
  checked **before** each call against that call's worst case (whole prompt at the cache-write
  rate plus `max_tokens` of output).
- **Errors as values.** Expected failures return `status: 'error'` with a domain error, a finer
  `reason` and what the run spent; unexpected errors (bugs, a rejected request) are thrown.
  Cancellation by the caller rejects with the signal's reason.
- **Open tool calls.** A successful run ends with the assistant message holding its terminal call
  (that message is the response). The provider requires every `tool_use` to be answered at the
  start of the next user message, so the **next turn's user message** starts with a
  `tool_result` ("Delivered to the user."), followed by the application's context block (date,
  trip brief) and the user's own words in a separate block. A run that fails, or whose output is
  blocked, closes its open calls itself, so a stored history never lies about what was delivered.
- **Context.** The system prompt is static and cacheable; today's date and the brief travel in
  the user turn. Tool results are compact JSON with the refs the model must cite.

## Consequences

### Positive

- The loop is covered by deterministic unit tests (fake LLM, fake ports, real timers at a few
  milliseconds), including the append-only property: each request extends the previous one.
- The domain does not depend on the SDK or on a beta helper; swapping the provider touches one
  adapter.
- Every rule that matters for grounding (terminal tools, repair, citation checks, limits) is in
  one readable place, and the eval calls the same code through the `SendMessage` use case.

### Negative

- We own the loop and must follow API changes ourselves (new stop reasons, block types, retry
  semantics). `pause_turn` is not handled because no server-side tool is used.
- No token streaming: the UI shows step events, and the final answer appears at once.
- A repair costs a full extra model call, and so does the plain-text reminder.
- Terminal calls cannot cite results of tool calls made in the same message; the prompt asks for
  the terminal call alone, after the other tools have returned.

### Follow-ups

- Tune `maxSteps`, `maxRepairs`, timeouts and the cost ceiling from the evaluation results
  (milestone 5); the current values are the plan's starting points.
- Verify the loop against the real API with the dev CLI (`src/cli/chat.ts`) once a key is set.

## Alternatives considered

- **Anthropic SDK tool runner** (`client.beta.messages.toolRunner`): less code and per-turn hooks,
  but it is a beta helper that hides the loop, couples the domain to the SDK, and our terminal
  tool validation, repair, evidence registry and run limits would end up in hooks around it.
- **LangChain / LangGraph, Vercel AI SDK:** general abstractions with their own message model;
  more surface to explain than the loop they would replace, and opaque provider blocks would have
  to survive their conversions.
- **Claude Managed Agents:** hosts the loop and a sandbox; we need neither, and grounding checks
  must run on our side, before anything reaches the user.
- **Forced `tool_choice` on a final "respond" tool:** rejected with a 400 on Sonnet and Opus 5.5,
  and on Haiku 5.5 a forced call skips thinking. `auto` plus a prompt instruction and a reminder
  keeps the agent portable across the models the eval compares.
