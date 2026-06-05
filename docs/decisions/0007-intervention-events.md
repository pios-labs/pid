# 0007 — Synthetic intervention events: `pid_quarantine`, `pid_budget_pause`, `pid_budget_resume`

- **Status:** Accepted
- **Date:** 2026-06-05
- **Deciders:** Steven (decisions), Claude (analysis)

## Context

The observability mandate (workspace `CLAUDE.md`; memory `observability-mandate`) requires that **every** pid intervention — approval, crash quarantine, budget pause/resume — lands in the single per-service chronicle (`logs/<name>.jsonl`) under a **documented public contract**, so anyone can build a GUI or feed pid into a pi dashboard.

ADR 0004 §11 shipped the first of these (`pid_approval`) and explicitly named the rest as "to follow on the other consumers": the crash detector (ADR 0003) and the cost governor (ADR 0002) were already *acting* (quarantine / pause / resume) but writing **nothing** to the chronicle. ADR 0005 fixed the envelope (`{v, ts, service, source, type, data}`); this ADR fills in the two remaining `source:"pid"` event types and their `data` payloads.

The v0-spec reserved placeholder rows for these (`pid_quarantine → signature, reason`; `pid_budget_pause/resume → dimension, window, limit, spent`). Implementing them surfaced three decisions.

## Decision

**1. Emit via the existing action seam, mirroring `logApproval`.** Logging is a supervisor capability the consumer drives, exactly like `ApprovalActions.logApproval` sits beside `send`:

- `CrashActions` gains `logQuarantine(name, data)`; the detector calls it at the quarantine trigger.
- `BudgetActions` gains `logBudgetPause(name, data)` and `logBudgetResume(name, data)`; the governor calls them at the pause / resume points.
- The supervisor implements all three over one private `logPidEvent(name, type, data)` helper (the generalisation of the old `logApproval` body), so every `pid_*` line goes through one enveloped writer (ADR 0005). `CostGovernor implements BudgetActions` already, so it gets two delegating stubs alongside its existing `pause`/`resume` delegators — consistent, no structural change.

**2. Rich, code-mirroring payloads (the public contract).** Rejected the lean spec sketch (`reason`, single `dimension`) in favour of payloads that mirror the code's own shapes (no translation layer) and capture the full "why":

| `type` | `data` |
|-|-|
| `pid_quarantine` | `signature`, `count`, `threshold`, `windowSeconds`, `by: "crash_detector"` |
| `pid_budget_pause` | `breached[]` (`{cap, limit, spent, windowEnd}`, one per tripped cap — a single message can trip daily *and* weekly), `resumeAt`, `by: "governor"` |
| `pid_budget_resume` | `by: "timer" \| "manual"` |

`breached[]` mirrors `BreachedCap` verbatim; `cap` uses the code's `CapKind` term (budget is pid-native, not a pi concept, so we are not bound to pi's idiom here as we are for `source:"pi"` lines). `by` mirrors `pid_approval`'s actor field. A dashboard can reconstruct the operator-facing sentence ("paused — hit the $10 daily cap, back at midnight") directly from the fields.

**3. The log-write is sequenced around the run, because the chronicle is the live process's stream.** `logPidEvent` no-ops when the service isn't running (inherited from `logApproval`, ADR 0004 §11 — a stopped service has no `RunningProcess.log`). Since a pause/quarantine *stops* the service and a resume *starts* it:

- **pause / quarantine** are logged **before** the stop that fulfils them (stream still open);
- **resume** is logged **after** the start (stream now open);
- a budget pause **re-established on daemon boot** (`recover()`, recovering a service already over-cap) writes **no** line — it restores a prior pause without a run, and there is no stream;
- a manual `pid resume` that immediately re-pauses (a surviving guardrail still breached) emits the pair `pid_budget_resume{by:manual}` then `pid_budget_pause{by:governor}` — the chronicle tells the whole story.

## Scope / deferral

**Manual `pid quarantine` (and CLI-action logging generally) is deferred.** The three events here are the **consumer-driven automatic** interventions named by the mandate, and they always have a live stream by construction. Manual CLI actions (`pid quarantine`/`stop`/`enable`/…) flow daemon→supervisor, bypassing the consumers, and — crucially — usually target a **stopped** service with no stream to write to. Logging them properly is its own increment with its own problem to solve (where does an intervention on a stopped service get written — a daemon-level log, or lazily open the stream?). Shipping just manual-quarantine here, best-effort, would be an inconsistent contract (`quarantine` logs sometimes, `stop` never). Out of scope; revisit as "manual-action logging".

**`notify`-mode breaches emit no event.** This ADR logs *interventions* (pause/resume/quarantine); a `notify`-mode cap breach does not pause, so there is nothing to log here — it remains visible via `status`/`lastBreach`. A future `pid_budget_breach` (observe-only) event could be added if the dashboard wants it.

## Consequences

- Three new methods on two action interfaces + the supervisor; one private `logPidEvent` consolidates the writer. No new module, no protocol/daemon change.
- The v0-spec "Log line schema" table rows for the three events move from *(planned)* to the real contract, with a sequencing note and a worked pause→resume example.
- Tests: the crash/governor unit harnesses capture the log calls and pin the exact payloads (the contract); two supervisor integration tests assert the lines reach the real `logs/<name>.jsonl` on disk end-to-end.

## Revisit when

- **Manual-action logging** lands → `pid_quarantine{by:"cli"}` and friends; resolve the stopped-service-has-no-stream question once, for all actions.
- The **dashboard / index** lands → confirm these payloads are sufficient to render the intervention timeline; treat any addition as additive (the schema `v` bumps only on a breaking change).
- pid grows a **relauncher** (auto-restart / triggers) → `proc:exit_<code>` becomes a countable crash signature (ADR 0003), so `pid_quarantine` may carry process-exit signatures too.
