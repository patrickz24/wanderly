# ADR 0007: LLM provider abstraction with opaque provider blocks

- **Status:** Accepted
- **Date:** 2026-10-10
- **Milestone:** 3

## Context

The agent loop must not depend on the Anthropic SDK (layering rule of
[ADR 0002](0002-layered-architecture-and-ports.md)), yet the Claude 5.5 API imposes constraints
that leak into any conversation store:

- **Reasoning blocks must round-trip.** Adaptive thinking is on by default; `thinking` blocks come
  back signed (with empty text by default) and must be passed back unchanged.
- **History must be append-only.** A thinking block stays valid only while everything sent before
  it (`system`, `tools`, earlier messages) is unchanged; editing that prefix returns a 400 on
  accounts created after 2026-08-31.
- **Prompt caching is a prefix match** in the order tools → system → messages.
- A lowest-common-denominator "text + tool calls" message model would silently drop the
  reasoning blocks.

## Decision

The domain port (`domain/ports/llm.ts`) speaks three assistant block types: `text`, `tool_call`
and `opaque`. The Anthropic adapter (`infrastructure/llm/anthropic-llm.ts`) maps:

- `text` ↔ text blocks, `tool_call` ↔ `tool_use` blocks;
- **every other block** (thinking, redacted thinking, any future type) → `opaque` tagged
  `anthropic`, stored as returned and replayed verbatim; opaque blocks of another provider are
  dropped from requests, so a conversation could change provider without rewriting the agent;
- consecutive same-role messages are merged and messages left empty are dropped, both
  deterministically, so a replayed prefix is byte-identical.

Around it:

- **Append-only storage.** The loop never edits a message (they are frozen); the use case appends
  `newMessages` to the store, and the `messages` table rejects updates.
- **Frozen prefix.** The system prompt has no per-turn data; the destination catalog in it is
  rendered deterministically; the canary token is stable across restarts; the tool list is fixed.
  Today's date and the trip brief go in the user turn.
- **Request rules** (checked in the claude-api skill, 2026-10-09): no `temperature`/`top_p`/
  `top_k`; `output_config.effort` from configuration; `tool_choice: auto` with strict tools;
  cache breakpoints on the last tool and the system prompt plus automatic caching of the
  conversation; SDK retries bounded and its timeout equal to our per-call deadline.
- **Errors.** Typed SDK errors become `LlmTimeoutError` (abort, SDK timeout) or
  `ProviderUnavailableError` (429, 5xx, 529, connection); request and authentication errors are
  rethrown as bugs. A served model different from the requested one is logged.

## Consequences

### Positive

- The loop and its tests know nothing about the SDK; a second provider is one adapter.
- Reasoning survives across turns and tool calls, and the stable prefix keeps the cache warm.
- Cost and observability use the provider's own usage figures, including cache reads and writes.

### Negative

- The port still leaks provider concepts (cache tokens, a `refusal` stop reason, strict tools),
  and opaque data cannot be inspected or shown.
- Any change to the frozen prefix breaks ongoing conversations: re-ingesting a corpus that changes
  the catalog, changing the canary, or editing a tool description invalidates their stored
  reasoning (a 400 on enforced accounts). Today these are deployment-time events; there is no
  migration path for live conversations.
- Mid-conversation `role: "system"` messages (the operator channel the provider recommends for
  harness notices) are not modelled by the port; the context block and the plain-text reminder
  are user-turn text in separate blocks instead.
- Text citations and other block fields we do not use (`citations`, `caller`) are not kept.

### Follow-ups

- Verify against the real API (pending a key): cache hits on a second call, thinking replay over
  several turns, and the served model.
- If the catalog must change under live conversations, version the prompt per conversation.

## Alternatives considered

- **Store only text and tool calls:** simplest, but drops thinking blocks, which degrades
  multi-turn reasoning and fails the provider's history check.
- **Store SDK types directly in the domain:** no mapping code, but couples the loop, the tests and
  the database format to one SDK version.
- **Strip thinking blocks and retry on a 400:** the provider's documented one-time recovery, not a
  steady state; it loses reasoning and the cache on every turn.
