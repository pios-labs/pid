# 0003 — Crash-loop detector: failure signatures, quarantine, scope

- **Status:** Accepted
- **Date:** 2026-06-01
- **Deciders:** Steven (decisions), Claude (analysis)

## Context

The crash-loop detector is the second consumer behind the supervisor's `onServiceEvent` seam (the cost governor, ADR 0002, was the first). Its job: notice when a supervised service keeps hitting the **same failure** and, past a threshold, **quarantine** it — stop the subprocess and refuse to restart it until a human runs `pid unquarantine`. This is the "a human would have pulled the plug" reflex, automated. It is the one failure mode pi will not handle itself: pi keeps a live agent running through tool failures and add-on errors — it does not stop a model that retries a doomed action turn after turn.

Detection rests on naming each failure with a **signature** (so "same failure again" is distinguishable from "a different failure") and counting same-signature occurrences in a rolling time window.

### Verified pi event facts (pi @ `e56521e3`)

All four failure sources were checked against pi's actual source, not docs alone:

| Source | Shape (verified) | Signature | Source ref |
|-|-|-|-|
| failed tool | `{ type: "tool_execution_end", toolName, isError: true, result }` — no structured exit code, only the `isError` flag | `tool:<toolName>:error` | `core/extensions/types.ts:704`; emit `core/agent-session.ts:663` |
| add-on threw | emitted as `{ type: "extension_error", extensionPath, event, error }` | `ext:<extensionPath>:<event>` | emit `modes/rpc/rpc-mode.ts:348`; type `extensions/types.ts:1568` |
| agent gave up | `{ type: "agent_end", messages, willRetry }`; `stopReason` is on the **last assistant message** in `messages[]`, not on the event | `agent:error` | `core/agent-session.ts:126`; `willRetry` computed `~549`, emitted `~503` |
| process died | not an event — a Node `child_process` non-zero exit; the supervisor already derives this | `proc:exit_<code>` | `supervisor/index.ts` `finalizeExit` |

Two facts from the source that are **load-bearing for correctness**:

1. **`stopReason` has distinct values** `"stop" | "length" | "toolUse" | "error" | "aborted"` (`packages/ai/src/types.ts:277`). `"aborted"` is *separate* from `"error"`. pid's own pause/stop (ADR 0001/0002) cancels turns and closes stdin, which surfaces as `"aborted"` — so keying the `agent:error` signature strictly on `stopReason === "error"` means **pid never miscounts its own interventions as crashes**.
2. **`willRetry` lives directly on `agent_end`** and is `true` while pi is auto-retrying a transient error internally. Those retries are pi's own business and must be ignored — the `agent:error` signature is only counted when `willRetry === false` (pi has actually given up).

The config surface already exists (`quarantineSchema`): `same_failure_threshold` (default 3), `window_seconds` (default 300). The `"quarantined"` service state already exists in `ServiceRecord`/`state.json`. ADR 0002 explicitly **deferred** the `quarantine` budget action to here, to avoid two modules co-owning the `quarantined` state — this ADR resolves that: the crash detector owns `quarantined`, the cost governor owns `paused`.

## Decisions

1. **Signature derivation lives in the detector (mirrors the cost governor).** The detector holds a pure event→signature function for the three **stream** sources, exactly as the governor seals `extractUsage` inside itself; the supervisor stays ignorant of pi's event shapes and just forwards events. The one exception is `proc:exit_<code>`: only the supervisor sees the child die, so it keeps deriving that signature (it already does) and hands it to the detector. Result: pi event-shape knowledge is contained in one file, unit-testable in isolation, and the one-fix-on-drift property the governor has is preserved. The detector therefore has two entry points (stream + exit) — inherent to crash detection having two channels, not a wart.

2. **Threshold over a rolling, same-signature window.** On each failure: derive signature, prepend to the service's recent-failures list, prune entries older than `window_seconds`, count occurrences of *that same* signature; at `>= same_failure_threshold`, quarantine. Counting is **per-signature**, not total failures (a service failing many *different* ways is a different, noisier signal — out of scope).

3. **The rolling window is in-memory; the quarantine decision persists.** The not-yet-quarantined failure count lives in memory and resets if the daemon restarts; the terminal `quarantined` state persists for free via `ServiceRecord.state` in `state.json` (a quarantined service comes back quarantined). This is a **deliberate asymmetry** with the cost governor, which *does* persist its numbers — and the asymmetry is principled: **money already spent is an unrecoverable fact** (forget it and a service blows its daily cap twice), whereas **a failure count is a self-regenerating signal** (if the service is still broken it re-trips the threshold in seconds). Different epistemics → different persistence.

4. **v0 wires the three live (in-session) signals only; `proc:exit_*` counting is deferred.** `tool_execution_end`, `extension_error`, and `agent_end` all fire *while the process stays alive*, so they loop **today** with no other machinery. A dead process can only *loop* if something **relaunches** it — an auto-restart policy or a trigger re-fire — and **neither exists yet**. Feeding a single non-loopable exit into a loop-counter is inert code (the wing test: it does nothing until a future feature exists). The supervisor keeps computing `proc:exit_<code>` into `lastFailure` (still visible on `pid status`); it is simply not fed to the counter until a relauncher lands.

5. **Quarantine action: graceful stop + terminal state, via an injected seam.** On threshold the detector drives a supervisor `quarantine(name)` action (mirroring the governor's `BudgetActions` seam) that gracefully stops the child (reuses `stop()`, ADR 0001 — so the closing events still flush) and sets state `quarantined`. Unlike the governor's `paused`, quarantine is **terminal: no auto-resume** — a repeating failure will not fix itself on a timer, and auto-resuming would just re-enter the loop. A **bare `pid start` on a quarantined service is refused** (mirrors the budget-paused guard) with guidance to clear it; **`pid unquarantine <name>`** clears the failure history and returns the service to `stopped` so it can be started again.

## Alternatives considered / deferred (with reasons)

- **Supervisor computes all signatures; detector is a dumb counter.** Rejected: it copies pi's `tool_execution_end` / `extension_error` / `agent_end` field knowledge into the supervisor — exactly the coupling the cost governor was built to avoid. The asymmetry of `proc:exit_*` being supervisor-derived does not justify moving the *other three* out of the contained, testable extractor.
- **Persist the rolling window to disk (a `CrashStore` mirroring `BudgetStore`).** Deferred, not rejected. It would protect a service flapping right at the threshold across a daemon restart — a narrow edge. Cost: a new store + boot-recovery path for a signal that regenerates itself, plus the jumpiness of re-quarantining from pre-restart counts when we don't yet know the service is still misbehaving. **Revisit if** flap-across-restart proves a real operational problem.
- **Wire `proc:exit_*` into the counter now (for spec completeness).** Deferred. It is provably non-load-bearing until an auto-restart loop or trigger executor exists; wiring dormant plumbing because the spec table lists four rows is the spaceship instinct. **Revisit when** the restart loop / trigger executor lands — hookup is a one-line `recordExit` call, and that is the natural moment to also decide that a quarantined service blocks restart.
- **Total-failure threshold (any N failures, regardless of signature).** Not adopted: the spec's contract is `same_failure_threshold`, and same-signature is the high-signal case (a stuck loop). A distinct-failure guard could be added later if a real need appears.
- **Counting `aborted` stopReason or `willRetry === true`.** Rejected by construction — these are pid's own interventions and pi's own internal retries respectively; counting either would cause premature/false quarantine. This is the core correctness guard, not a tuning knob.
- **Auto-resume after a cooldown (like the governor's window reset).** Rejected: a budget breach clears itself when the clock rolls; a crash loop does not clear itself on a timer. Quarantine stays terminal and human-cleared.

## Consequences

- The detector is structurally a near-twin of the cost governor: same `onServiceEvent` seam, same injected-actions pattern, same "extractor sealed in the consumer" containment. Whoever understands one understands the other.
- Quarantine requires manual `pid unquarantine` — intentional friction; the operator decides the underlying fault is fixed.
- No new persistence store. Work is: fleshing out the existing `src/governor/crash.ts` stub, a `quarantine(name)` action on the supervisor, the `quarantined`-state `start()` guard, `pid unquarantine` CLI + daemon dispatch (currently throws `not implemented`), and status surfacing.
- The `proc:exit_*` path is a **known, documented gap** until restart/triggers land — visible on status, not yet counted.
- Daemon restart resets in-flight counts (accepted); quarantine survives.
- Closes the ADR 0002 deferral: `quarantined` has a single owner (this detector); `paused` stays the governor's.

## Revisit when

- An auto-restart loop or trigger executor lands → wire `proc:exit_*` into the counter, and make a quarantined service block restart.
- Flap-across-daemon-restart proves a real problem → reconsider a persisted window (`CrashStore`).
- pi changes any of the four event shapes (watched via `/refresh-pi`) → update the signature extractor; its unit tests are pinned to the verified shapes above.

## References

- Verified pi event shapes: `core/extensions/types.ts` (`ToolExecutionEndEvent`, `ExtensionError`), `core/agent-session.ts` (`agent_end` + `willRetry`), `packages/ai/src/types.ts` (`StopReason`), `modes/rpc/rpc-mode.ts:348` (`extension_error` emit)
- `pid/docs/v0-spec.md` — "Product: crash-loop quarantine"
- ADR 0001 (graceful `stop()` reused by quarantine), ADR 0002 (the `quarantine`-action deferral resolved here)
