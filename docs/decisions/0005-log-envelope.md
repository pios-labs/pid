# 0005 — Per-service log envelope: one chronicle schema for pi + pid events

- **Status:** Accepted
- **Date:** 2026-06-03
- **Deciders:** Steven (decisions), Claude (analysis)

## Context

The observability mandate (workspace `CLAUDE.md`; memory `observability-mandate`) makes comprehensive, **documented** logging non-negotiable, and promotes an example GUI/dashboard to a top pre-go-live deliverable. A dashboard — or any third-party integration — needs to treat a service's activity as one timeline and merge many services together. Two facts made the existing log unfit for that:

- pid wrote pi's events **raw** (`supervisor/index.ts`, `log.write(JSON.stringify(event))`) and its one synthetic event, `pid_parse_error`, as a flat `{type, error, raw}` — **no timestamp, no service tag** on any line. Chronology was line-order only; absolute time and cross-service provenance were unrecoverable.
- pi's stream events carry **no timestamp** (`agent/src/types.ts`: `tool_execution_start` is `{type, toolCallId, toolName, args}`, etc.). So if the log is to have time, *pid* must stamp it at receive.

This decision was pulled forward (a small increment **before** the approval router) so that the router's `pid_approval` event — now a documented public contract — is born consistent, and so the cross-cutting format change isn't buried inside the router commit.

## Decision

**Every line in `logs/<name>.jsonl` is wrapped in one envelope:** `{ v, ts, service, source, type, data }`.

- `v` — schema version (the line format is a public contract third parties parse; starts at `1`).
- `ts` — ISO-8601, **pid's** write time (pi events have none; pid stamps it).
- `service` — the service name (provenance survives a many-service merge).
- `source` — `"pi"` (pi's event stream) or `"pid"` (pid's own synthetic events).
- `type` — pi's `type` verbatim, or a `pid_*` type.
- `data` — the event-specific payload, **nested**.

**Standardise the envelope, not pi's payloads.** pi's event-specific fields are preserved **verbatim** under `data` — we never rename them (the pi cross-reference rule; renaming would diverge from pi's own docs and confuse anyone fact-checking against pi source). pid's own synthetic payloads use pi's idiom (camelCase, `toolName`). So "consistent naming where possible" resolves to a consistent *common envelope* with native payloads underneath.

**Nested `data`, not flattened.** The pi event sits intact under `data` rather than spread alongside the envelope keys: it keeps the pi event recoverable exactly as pi emitted it, and removes any chance of an envelope key (`v`/`ts`/`service`/`source`) shadowing a pi field.

**One write path.** A pure helper (`util/log.ts`: `formatPiEvent`, `formatPidEvent`, `LOG_SCHEMA_VERSION`) builds the line; the supervisor — which already funnels every log write through two sites — calls it. New `pid_*` emitters (the approval router, later the crash detector and cost governor) go through the same helper, so the envelope is defined in exactly one place. The schema is documented in `docs/v0-spec.md` "Logging".

**The envelope is a log-format concern only.** `onServiceEvent` still receives the raw parsed pi event — the cost governor and crash detector are unchanged; they react to the event, not the log line.

## Alternatives considered / rejected

- **Flattened payload** (envelope keys + pi fields at one level). Rejected: risks an envelope key colliding with / shadowing a pi field, and loses the "recover the exact pi event" property. Nesting is safer; the marginal `grep`-ability loss is immaterial once a reader/index exists.
- **Keep pi events raw; only standardise pid's synthetic events.** Rejected: leaves pi's events without `ts`/`service`, so a merged multi-service dashboard timeline can't be reconstructed — the exact thing the mandate requires.
- **Rename fields for cross-event consistency** (e.g. a uniform `tool` everywhere). Rejected: pi's fields are pi's contract; renaming breaks the cross-reference rule. Consistency lives in the envelope only.
- **Defer the envelope until the dashboard is built.** Rejected: `pid_approval` ships now as a public contract; standing the envelope up first means it (and `pid_parse_error`) are born consistent, avoiding a later format break.

## Consequences

- New module `src/util/log.ts` (small, pure) + the supervisor's two existing write sites converted. Format change only; pid is pre-1.0 with no shipped logs to migrate.
- Existing substring-based log assertions survive (the `type` value and verbatim pi payload remain present under `data`).
- Establishes the convention for **all** pid interventions: `pid_approval` (ADR 0004) now; `pid_quarantine`, `pid_budget_pause`/`_resume` to be retro-added to the crash detector and cost governor as part of the observability deliverable.

## Revisit when

- The dashboard/index lands → the envelope is the ingestion contract; bump `v` if it changes, and decide retention/rotation then (the raw chronicle stays source of truth; speed comes from an index over it).
- A consumer needs a field the envelope lacks (e.g. a turn/correlation id) → add it to the envelope uniformly and bump `v`, rather than special-casing one event type.
