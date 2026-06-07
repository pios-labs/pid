# 0012 — `pid_service_exit`: a chronicle event for abnormal termination

- **Status:** Accepted
- **Date:** 2026-06-07
- **Deciders:** Steven (decisions), Claude (analysis)

## Context

Building the example dashboard (ADR 0011) surfaced this live: starting the example services (whose `cwd` points at directories that don't exist on a fresh box) put every card into `FAILED` — correctly — but the **timeline stayed empty** and **no alert fired**. The failure was visible only as `lastFailure` on a live `pid status` / snapshot, never in the chronicle.

The cause is structural. `Supervisor.finalizeExit` sets `record.lastFailure` to `proc:spawn_error` (the command could not be spawned — bad `cwd`, missing binary) or `proc:exit_<code>` (exited non-zero), but writes **nothing to the chronicle**. Every other intervention emits a documented `pid_*` event (ADRs 0004 §11, 0007) — but an abnormal *exit* did not, and uniquely it has to: a process that fails to spawn or dies mid-flight emits **no pi event** (pi never started, or the stream just stops), so unlike a quarantine or a budget pause there is no pi-side record to lean on. Without a synthetic line, the observability mandate's "every crash … must be logged and viewable" has a hole exactly where it matters most — the dashboard can't show what was never recorded.

The crash detector already counts *in-session* failures from pi's own events (`tool:…:error`, `agent:error`); `proc:exit_*` *counting* remains deferred until a relauncher exists (workspace `CLAUDE.md`). This ADR is about **observability**, not detection: recording the exit, not acting on it.

## Decision

Emit a synthetic **`pid_service_exit`** chronicle event from `finalizeExit` whenever a supervised process terminates **abnormally** — i.e. exactly when the disposition is `failed` (`proc:spawn_error` or `proc:exit_<code>`). Payload: `{ signature, code, signal, error? }` (the `lastFailure` signature, the exit code/signal, and the spawn-error message when there was one). It is written to the **still-open** writer just before `running.log.end()`, with the reader already detached so nothing races it.

- **Abnormal only.** A clean stop (graceful `stop()` → code 0) or a signalled teardown (our own SIGTERM/SIGKILL) is **deliberate** and writes no line — its graceful pi shutdown is already in the chronicle, and a synthetic event there would be noise. This keeps the event meaning "something went wrong," which is what the alert rail wants.
- **Observability only, no detection coupling.** The event is written to the chronicle file; it is *not* fed back through `onServiceEvent`, so the crash detector is unaffected and the deferred `proc:exit_*` counting decision stands untouched.
- **Congruent with the existing `pid_*` family** (ADR 0005 envelope, ADR 0007 intervention events). It rides the same `logPidEvent`-style write and the same documented "Log line schema" contract.

Surfaced in the example dashboard: a timeline row and an entry in the alerts rail (the empty-timeline observation that prompted this).

## Alternatives considered

- **Leave it as `lastFailure` only (status-time).** Rejected: a dashboard/3rd-party consumer tailing the chronicle never sees the failure; it contradicts the mandate's "viewable in a documented schema."
- **Log *every* exit, including clean stops.** Rejected for now: clean stops are deliberate actions whose story the chronicle already tells (pi's shutdown events); a `pid_service_exit{code:0}` on every stop is noise and dilutes the alert signal. The event name leaves room to widen later if a real need appears.
- **Reuse `pid_quarantine`.** Wrong semantics: quarantine is a crash-loop *intervention* by the detector; a one-off spawn failure or crash is a lifecycle fact. Conflating them would corrupt both contracts.

## Consequences

- **New public event type** `pid_service_exit` — added to the v0-spec "Log line schema" (the contract) alongside the other `pid_*` events.
- `finalizeExit` restructured slightly: the disposition is computed *before* the log is ended so the event can be written to the open writer; the `!record` early-return now ends the log first (no leak).
- The dashboard's timeline `summarize()` and alerts now recognise `pid_service_exit`.
- Covered by a supervisor test (spawn failure → chronicle contains `pid_service_exit{signature:proc:spawn_error}`).

## Revisit when

- A relauncher (auto-restart loop) lands → revisit whether `pid_service_exit` should also carry restart intent (`willRestart`, attempt count) and how it pairs with the deferred `proc:exit_*` crash counting.
- A genuine need to record clean stops appears (e.g. an uptime/session ledger) → consider widening to all exits with a `clean` flag, rather than a second event type.
