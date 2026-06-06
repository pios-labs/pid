# 0009 — Chronicle event selection: drop pi's streaming frames

- **Status:** Accepted
- **Date:** 2026-06-06
- **Deciders:** Steven (decision), Claude (analysis)

## Context

ADR 0005 established the per-service chronicle (`logs/<name>.jsonl`) as "every event pi emits, verbatim under `data`". Implementing the log reader (ADR 0008 increment 2) forced a fact-check of *what pi actually emits* on its `--mode rpc` stdout stream — and it emits two classes of **high-frequency streaming frames** that re-embed a growing buffer on every chunk (`pi/.../docs/rpc.md`):

- **`message_update`** — one per token-chunk during an assistant message (`text_delta` / `thinking_delta` / `toolcall_delta`), each carrying `partial: {…}`, the *entire message-so-far*.
- **`tool_execution_update`** — streams a tool's progress, each frame carrying `partialResult` = the **full accumulated output so far** (explicitly "not just the delta", so a client can replace its display each tick).

Because each frame re-sends the growing buffer, a single N-token message produces ≈ N frames whose sizes grow linearly → **O(N²)** bytes for one message; a chatty `bash` does the same via `tool_execution_update`. Logging these verbatim would make the chronicle 10–100× larger than the meaningful content, dominated by redundant half-rendered partials.

Two facts make them safe to drop: the terminal **`message_end`** carries the full final `message`, and **`tool_execution_end`** carries the full final `result` (both verified in `rpc.md`). So the streaming frames are **redundant for a persistent log** — nothing about the final state is lost by omitting them. pi's own session persistence likewise stores final **messages**, not per-token deltas.

This surfaced because ADR 0008's "no index, scan is cheap" decision rests on the chronicle being *small*; persisting deltas would silently invalidate that premise, and a one-line-per-event reader view would be buried under thousands of delta lines.

## Decision

**The chronicle persists lifecycle events, not streaming frames.** A small sealed set names the dropped types; everything else (including anything unrecognised) is kept.

- `src/util/log.ts` gains `STREAMING_FRAME_TYPES = { message_update, tool_execution_update }` and a pure `persistsToChronicle(event)` predicate (keeps the type unless it is a known streaming frame; keeps non-object / typeless lines — we only suppress *known* noise, never guess).
- The supervisor gates **only the log write** on the predicate: `if (persistsToChronicle(event)) log.write(...)`. **`onServiceEvent` still receives every event** — the cost governor, crash detector and approval router are unaffected (none of them key off the `*_update` frames anyway: cost charges on `message_end`, crash on `tool_execution_end.isError` / `extension_error` / `agent_end`, approvals on `extension_ui_request`).

This is a **conscious, documented divergence from ADR 0005's "verbatim every event"**: we keep every *persisted* pi payload verbatim under `data`, but the chronicle is now a curated stream of lifecycle events rather than a byte-for-byte mirror of pi's stdout. The envelope schema and version are unchanged (no `v` bump — this is about *which* lines are written, not their shape).

## Alternatives considered

- **Verbatim everything (status quo).** Full exact-stream fidelity (could replay token-by-token), but the O(N²) blowup makes logs huge, trips the rotation size-cap constantly, churns archives, weakens the no-index premise, and forces the reader to filter deltas for display regardless. Rejected — fidelity we have no observability use for, at a large standing cost.
- **Keep a thinned per-delta marker** (strip `partial`/`partialResult`, keep `{type, len}`). Still emits one line per chunk (noisy), for marginal value over dropping. Rejected.
- **Filter in the reader, not the writer.** Keeps the disk mirror "complete" but pays the full disk cost and complicates every reader. Rejected — bound the data at the source.

## Consequences

- The chronicle is bounded and one-line-per-real-event; ADR 0008's scan/no-index decision is now *correct* rather than aspirational, and the rotation size-cap becomes a rare safety net rather than a constant trigger.
- ADR 0005's "verbatim every event" wording is superseded on the *selection* point (not the envelope): the v0-spec "Logging" `source: "pi"` note records the dropped types.
- Tests: a `persistsToChronicle` unit table (drops the two, keeps lifecycle + unknown), plus a supervisor integration assertion that a `message_update` emitted by the fake-pi fixture never reaches `logs/<name>.jsonl` while `message_end` does.

## Revisit when

- pi adds another high-volume streaming frame type → extend `STREAMING_FRAME_TYPES` (the set is the one place to change).
- A real need for token-level replay appears (e.g. debugging pi itself) → consider an opt-in `--verbatim` capture mode rather than re-bloating the default chronicle.
- The dashboard (increment 3) wants live token streaming → it can subscribe to `onServiceEvent`-equivalent live data via tail-follow of lifecycle events, or pi directly; it does not need the deltas on disk.
