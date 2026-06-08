# Architecture Decision Records

One file per significant architectural decision for `pid` — numbered, append-only. An ADR captures the **context**, the **decision**, the **alternatives considered**, the **consequences**, and **when to revisit**. They exist so the reasoning behind a choice survives long after the conversation that produced it — the antidote to the "compounding booboos" failure mode where undocumented deferrals rot and the *why* is lost between versions.

## When to write one

Write an ADR when a change involves any of:

- a new module or abstraction,
- a new dependency,
- a divergence from pi's own conventions,
- a non-obvious scope or deferral call (something deliberately *not* built, with a real reason).

Routine implementation does not need one — a focused code comment carries implementation-level rationale. The ADR carries the *decision*.

## Status values

`Proposed` · `Accepted` · `Superseded by NNNN`

## Index

- [0001](0001-supervisor-stop-teardown.md) — Supervisor.stop() teardown: stdin-close over SIGTERM — **Accepted**
- [0002](0002-cost-governor.md) — Cost governor: budget model, pause semantics, windows — **Accepted**
- [0003](0003-crash-loop-detector.md) — Crash-loop detector: failure signatures, quarantine, scope — **Accepted**
- [0004](0004-approval-router.md) — Approval router: policy model, matching semantics, host-reply path — **Accepted**
- [0005](0005-log-envelope.md) — Per-service log envelope: one chronicle schema for pi + pid events — **Accepted**
- [0006](0006-cli-human-readable-output.md) — Human-readable CLI output by default; `--json` opt-out (the CLI render pass, D2) — **Accepted**
- [0007](0007-intervention-events.md) — Synthetic intervention events: `pid_quarantine`, `pid_budget_pause`, `pid_budget_resume` — **Accepted**
- [0008](0008-observability-read-path.md) — Observability read path: daemon-free CLI reader, no index (scan + tail-follow), daily-segment rotation, lean example web dashboard — **Accepted**
- [0009](0009-chronicle-event-selection.md) — Chronicle event selection: persist lifecycle events, drop pi's high-frequency streaming frames (`message_update`/`tool_execution_update`) — **Accepted**
- [0010](0010-reload-semantics.md) — `pid reload`: service-set reconciliation by disk presence, never interrupting running work (orphan-on-stop, staged config + `pid_config_changed`) — **Accepted**
- [0011](0011-example-dashboard.md) — Example dashboard: API-first HTTP/SSE facade (pure CLI consumer), actions-on + `--read-only`, localhost+origin floor, embeddable web component — **Accepted**
- [0012](0012-service-exit-event.md) — `pid_service_exit`: synthetic chronicle event for abnormal process termination (spawn error / non-zero exit) — **Accepted**
- [0013](0013-restart-relauncher.md) — Restart relauncher: auto-restart on crash (policy/backoff/give-up); unlocks process-exit crash quarantine — **Accepted**
- [0014](0014-triggers-jobs-and-pid-run.md) — Triggers as supervised jobs: `pid run` + native `file_watch`; native cron delegated to the OS — **Accepted**

## Verification status

These decisions describe pi-runtime behaviour. After a verification campaign re-earned every load-bearing claim against the **real `pi` binary** (the prior fake-pi-only tests had hidden a core gap — the prompt was never delivered) — and a pre-launch audit then caught two features documented-but-unbuilt (restart, triggers), which were built and verified — each is now backed by a re-runnable receipt. The single cross-reference is **[`../../verification/LEDGER.md`](../../verification/LEDGER.md)** (28 rows: CP1–CP7 + the post-audit remediation); receipts live in `verification/scenarios/`, and `npm run test:real` runs them all (14/14 green against pi 0.78.1). The ADR↔checkpoint map:

| ADR | Verified by | Receipt |
|-|-|-|
| 0001 (stop teardown) | CP5 | `s6-stop-shutdown.sh` (exit 0 vs 143) |
| 0002 (cost governor) | CP2 (tokens), CP7 (USD) | `s5-budget-pause.sh`, `s9-dollars.sh` |
| 0003 (crash detector) | CP1, CP3 | `errored-turn.sh`, `s3-crash-quarantine.sh` |
| 0004 (approval router) | CP4 | `s4-approval.sh confirm`/`select` (the host→pi reply path) |
| 0005 / 0007 (log envelope, intervention events) | CP2/CP3/CP4 | the `pid_*` payloads in the above captures |
| 0008/0009/0011/0012 (observability, dashboard, exit event) | CP6 | `s8-dashboard.sh` |
| 0010 (reload) | CP5 | `s7-reload.sh` (running work never interrupted) |
| 0013 (restart relauncher + proc-exit quarantine) | post-audit | `s10-restart.sh` (kill→relaunch; kill-loop→quarantine) |
| 0014 (`pid run` + `file_watch` triggers) | post-audit | `s11-run.sh`, `s12-file-watch.sh` |

A gated `npm run test:real` re-runs all receipts; a fixture-drift unit test (`test/fixture-drift.test.ts`) fails if any fake-pi fixture diverges from its committed real capture (CP8).
