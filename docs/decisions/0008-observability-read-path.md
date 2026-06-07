# 0008 — Observability read path: log reader, rotation, and the example dashboard

- **Status:** Accepted
- **Date:** 2026-06-05
- **Deciders:** Steven (decisions), Claude (analysis)

## Context

The observability mandate (workspace `CLAUDE.md`; memory `observability-mandate`) has three parts. Parts (a) **emit** and (b) **document** are done: every intervention writes a documented `pid_*` event (ADRs 0004 §11, 0007) into the single per-service chronicle `logs/<name>.jsonl` under the versioned envelope contract (ADR 0005). Part (c) is the remaining piece: make that chronicle **viewable** — a reader, fast filtered views, retention, and an example dashboard/GUI.

ADR 0006 fixed the governing posture: **the dashboard is a downstream consumer of a documented contract, never pid core** (plain CLI over a contract). So part (c) is not "build a GUI" — it is "decide where the boundary sits between pid and whatever renders the data," and that decision cascades into everything else. Four forks were surfaced and decided (BAP); this ADR records them, the pi-source cross-reference behind each (the mirror-or-diverge call), the resulting module/scope plan, and the deferrals.

Cross-reference pass (pi clone, read-only) findings that shaped the decisions:

- pi persists sessions to `~/.pi/agent/sessions/<encoded-cwd>/${fileTimestamp}_${sessionId}.jsonl` (ISO timestamp, `:`/`.`→`-`); `session-manager.ts:438-442,846`. **No rotation/retention** — pi segments naturally *per session* and keeps files indefinitely.
- pi's incremental JSONL read is `attachJsonlLineReader(stream, onLine)` (`modes/rpc/jsonl.ts:21-58`): LF-split, `StringDecoder` UTF-8, strips trailing `\r`, buffers partial lines. **No byte-offset tracking, no `fs.watch`/follow.** Session *replay* re-reads whole files from the start.
- pi events are mostly **unstamped**: only `turn_start` and message objects carry `timestamp` (`docs/rpc.md`); the rest do not.
- pi examples (`packages/coding-agent/examples/extensions/`) are single self-contained ~30–50-line `.ts` files. **No web UI / HTTP / dashboard anywhere in pi-mono.**

## Decision

### 1. Read path (the spine): files are the contract; the CLI is the blessed daemon-free reader.

The jsonl files remain the source of truth. `pid logs` / `pid tail` (today stubbed) become the official reader **over the files directly** — they do **not** go through the daemon (a read needs no supervisor), and `-f` follow is a filesystem watch on the growing file, which the running pi child is already writing through the supervisor. The dashboard is just another consumer of the same files / the same `--json` output. **The daemon and the approval/budget/crash cores are not modified.**

*Mirror:* pi itself exposes JSONL and lets consumers read the files; it ships no bundled dashboard daemon. Keeping reads daemon-free and the daemon request/response-only honours both pi's convention and ADR 0006.

*Rejected:* a daemon streaming `tail`/`query` RPC (the only option that grows pid core) — it is the wing. Local single-user follow needs `fs.watch`, not a push server. Revisit only if multi-subscriber push becomes real.

### 2. No index — scan bounded by rotation, live by tail-follow.

No SQLite, no homegrown offset index. Three read modes:

- **live** = tail-follow, O(new bytes) — `fs.watch` + incremental read from the last offset (the dashboard's websocket/SSE feed is the same primitive with a socket on the end);
- **initial load** = a bounded window (last N lines / last day);
- **filtered history** = a streaming scan, kept cheap by rotation (Decision 3).

At realistic v0 volumes (a few MB per run, tens of MB/week) a full scan is single-digit milliseconds; the empirical proof is that third-party dashboards already realtime-stream *pi sessions*, which are orders of magnitude larger, by tailing — they never re-scan history.

*Mirror:* pi's own replay re-reads whole files from the start (no index), so scan-based reading is the pi-congruent baseline. **Time filtering uses the envelope `ts`** (ADR 0005), because pi stream events are mostly unstamped — the envelope is the only reliable per-line clock.

*Divergence pressure-tested:* the mandate's wording named an "index/query layer." It was wing-tested and **deferred** — the index is not load-bearing at v0, and rotation is the cheaper cost lever. Revisit when a single query genuinely outgrows a rotation-bounded scan.

### 3. Rotation/retention: daily segments + a size safety-cap (pid-native).

The live file stays the documented `logs/<name>.jsonl`. At each **day rollover** (or if it crosses a **size safety-cap**) its contents roll to a **dated archive** `logs/<name>.<date>.jsonl`; a mid-day size-triggered roll disambiguates with a full hyphenated timestamp (`logs/<name>.<date>T<hh-mm-ss>.jsonl`, mirroring pi's filename timestamp idiom). Retention keeps the last **N days** (default ~30); older archives may be gzipped then pruned. Readers stitch archives + live in date order; tail-follow reopens across a roll (`tail -F` semantics).

*Divergence (recorded deliberately):* pi has **no** rotation — it relies on per-session file segmentation, which does not apply to pid's long-lived single-process services (one process, many sessions/turns over days). pid must segment by **time** instead. The dated-archive naming stays congruent with pi's hyphenated-timestamp filename convention. This is a change to the documented on-disk **layout** (the live path is unchanged; dated archives are additive), not to the line envelope — schema `v` does not bump.

### 4. The example web dashboard: lean, build-step-free, but genuinely polished.

A web dashboard served by a **separate, on-demand process** — never the daemon (consequence of Decision 1). Built build-free: a single self-contained HTML/JS page (vanilla, no framework/bundler) + a tiny Node server using built-ins (`http` + SSE = zero new deps, or one small dep such as `ws`), living in `examples/dashboard/`, launched on demand (a `pid dashboard` command and/or a documented `node` invocation), reusing the Decision-2 reader/tail as its feed. **Lean plumbing, deliberate presentation** — hand-crafted modern CSS (grid, dark theme, typographic hierarchy, color-coded event/state chips, inline-SVG cost sparklines), self-contained and offline. A reference users fork, not a shipped product.

*Mirror / extension:* pi-mono has no web example to copy, and its examples are single files; a web dashboard is necessarily a small directory. We place it under `examples/` (congruent) as a conscious extension of that convention.

*Rejected:* a framework SPA (React/Vue + bundler + ~300 deps) — it inverts the dependency weight of a 3-dep project and stops looking like "just a reader." The spaceship checkpoint.

## Scope / deferral

- **Index:** deferred (Decision 2). Revisit when a query outgrows a rotation-bounded scan.
- **Per-service rotation override:** a global retention default ships first; a per-service `budget`-style override is deferred (wing test — most users want one sane default).
- **`gzip` of old archives:** optional, behind the retention default; can ship in a follow-up if it complicates increment 1.
- **Daemon `logs`/`tail` stub dispatch:** since reads are daemon-free (Decision 1), the CLI reads disk directly and the old `logs`/`tail` daemon stubs are retired (not wired). The remaining stubs (`reload`, `budget_show`, `budget_reset`) are unaffected, separate post-v0 work.
- **Daemon push / multi-subscriber streaming:** rejected for v0 (Decision 1).

## Consequences

- **New modules** (each needs its own focused implementation, per the compounding-booboos discipline): a rotation/retention writer, a log reader (scan + stitch live+archives + filter on envelope `ts`/`type`/`source`), and a tail-follow streamer (`fs.watch` + offset, reusing pi's LF line-framing semantics already mirrored in the parser). Plus `examples/dashboard/` (page + server) and a `pid dashboard` launcher. Exact filenames settle at implementation under `src/log/`.
- **`pid logs` / `pid tail`** move out of the "deferred stubs" list into part (c); rendered via the existing `cli-render` / `--json` conventions (ADR 0006). The v0-spec "Logging" section's turn-grouped human view is the spec to mirror.
- **On-disk layout** gains dated archives (documented contract change; envelope unchanged).
- **Build plan** — three increments in dependency order, each docs-first, each its own commit: **(1)** rotation/retention; **(2)** `pid logs`/`tail` reader + tail-follow; **(3)** the example dashboard reusing (2)'s feed. This is the largest chapter since the supervisor — paced across sessions, not bulk-shipped.
- The v0-spec "Logging" / "Log line schema" sections gain the archive layout + the reader/filter contract; ADR 0007's chronicle remains the substrate.

## Revisit when

- A real workload makes a rotation-bounded scan too slow → add an index (the deferred Decision 2), choosing SQL vs offset by the actual query patterns.
- Users want per-service retention tuning → add the rotation override (a `budget`-style block).
- pi ships its own session viewer / tail idiom → mirror it and reconcile (currently nothing to copy).
- Multi-subscriber live push becomes a genuine need → reconsider a daemon streaming op (the rejected Decision-1 option).

## Amendment (2026-06-07) — `pid tail` has a dynamic follow-set

Building increment 3 (the example dashboard, ADR 0011) surfaced a gap in the increment-2 `pid tail`: it captured its follow-set **once at startup** (`listLiveServices` → one tailer per existing live file) and *exited* when none existed. That suited a human running it for a few minutes, but the dashboard's facade shells `pid tail --raw` as a **long-lived** feed, so any service that first started *after* launch was invisible until a re-run — and an empty start (a fresh box, daemon up, nothing run yet) errored out instead of waiting.

**Decision:** the follow-set is now **dynamic**. `pid tail` re-scans the logs dir on an interval — **polling**, the same mechanism `FileTailer` already uses, deliberately *not* `fs.watch` (whose rename/inode flakiness at the midnight roll Decision 4's writer also avoids) — and attaches any newly-appeared `<name>.jsonl`. A file present at launch is followed **live** (no history replay — it's a monitor); a file that **appears later** is brand-new, so it is read **from its start** (small, no flood) so the service's boot isn't missed. An empty start now **waits** rather than erroring. Status notices (`no services logging yet — waiting…`, `following <name>`) go to **stderr**, mirroring `tail -F`'s "has appeared; following" — stdout stays a pure event stream so `pid tail --raw | jq` and the facade are unaffected.

This is the "revisit when: pi ships its own tail idiom" line resolving the other way — pi still has **no** tail idiom to mirror (it re-reads whole session files), so the dynamic-discovery behaviour is wholly pid-native and decided on its own merits. The change is confined to `runTail` in `cli.ts` (client-side reader path — no daemon/protocol/writer/schema touch); it lets the facade **drop** its respawn-on-grow workaround and just spawn `pid tail --raw` once. Covered by an end-to-end `test/cli-tail.test.ts` (empty-start waits → late service discovered → streamed from event #1).
