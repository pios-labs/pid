# 0013 — Restart relauncher: auto-restart on crash, and unlocking proc-exit crash detection

- **Status:** Accepted
- **Date:** 2026-06-08
- **Deciders:** Steven (decision), Claude (analysis)

## Context

The `restart:` block (`policy: always|on-failure|never`, `max_consecutive`, exponential `backoff`) has been in the schema since v0 and is documented + sold ("`pid` restarts them when they crash"), but **no runtime ever read it** — `finalizeExit` only set a terminal `stopped`/`failed` state and never re-spawned. A pre-launch audit (2026-06-08) caught this as a claim-vs-reality gap of the same class as the fake-test failure: a marquee feature advertised but not built. This ADR wires it for real, verified against the live `pi` binary.

It also closes the loop ADR 0003 explicitly deferred: the crash detector's fourth signal, a non-zero **process exit** (`proc:exit_*`), "can only *loop* once something relaunches the process." That something now exists, so process-exit failures are fed to the crash detector — which makes the "240 identical failures → quarantine" hero scenario actually detectable.

## Decision

A new supervision module, `Relauncher` (`src/governor/restart.ts`), sits alongside the cost governor and crash detector: a small, injectable, unit-tested policy core the supervisor drives from `finalizeExit`. The pure decision (relaunch? after how long? give up?) lives in the module; the I/O (re-spawn, timers) is injected, mirroring `CostGovernor`.

**What triggers a relaunch.** Only an **unexpected** exit of a service that has **reached `running` at least once** in its current lifecycle. Two deliberate exclusions:
- **Deliberate stops never relaunch.** `stop`/`pause`/`quarantine`/`shutdown`/reload-orphan teardown route through `stop()`, which cancels the relauncher. Pausing a budget-blown service and having it instantly relaunch would be a disaster.
- **A first start that never reaches `running` is not relaunched** — it throws to the caller (`pid start` fails loudly, as it should). This prevents a misconfigured service from silently infinite-looping at startup. Once a service has run, subsequent crashes (including a relaunch that then spawn-fails) drive the loop, bounded as below.

**Policy** (on an unexpected exit, post-`running`):
- `never` → never relaunch.
- `on-failure` (default) → relaunch only on a failure exit (non-zero code, external signal, or spawn error); a clean self-exit (code 0) is left stopped.
- `always` → relaunch on any unexpected exit, clean or failed.

**Backoff + give-up.** Relaunch is scheduled after an exponential backoff (`initial_ms × factor^n`, capped at `max_ms`). A run that stays up longer than `max_ms` (the longest backoff — i.e. it recovered) resets the consecutive counter. At `max_consecutive` consecutive fast failures the relauncher gives up: the service is left `failed` and a `pid_restart` "exhausted" event is written. This is the flapping backstop.

**Crash-loop quarantine (the unlocked path).** On each unexpected **failure** exit the supervisor feeds the crash detector a synthetic `proc_exit` event → signature `proc:exit_<code>` / `proc:signal_<SIG>` / `proc:spawn_error`. A consistent crash loop therefore trips the crash detector's same-signature threshold (default 3) and **quarantines** (terminal, needs `pid unquarantine`) — typically *before* `max_consecutive` (default 5). So: a *consistent* crash → quarantine (strong, human-gated); a *flaky mix* the detector won't group → `max_consecutive` → failed. Quarantine cancels any pending relaunch.

**Observability.** Every relaunch and the give-up emit a documented `pid_restart` synthetic event (`{phase: "scheduled"|"exhausted", attempt, max, delayMs, signature, by:"relauncher"}`), consistent with the other `pid_*` intervention events (ADR 0007).

## Alternatives considered

- **Relaunch owned entirely by the relauncher (no crash-detector feed).** Simpler, but loses the strong terminal *quarantine* semantics for a real crash loop — the documented hero scenario — and would duplicate loop-detection the crash detector already does well. Rejected: feed the detector (ADR 0003's stated intent).
- **Relaunch on every exit including first-start failures.** Would "recover" a transiently-unavailable command, but silently infinite-loops a misconfigured service and makes `pid start` lie about success. Rejected in favour of fail-loud-on-first-start.
- **Treat any signal exit as deliberate (status quo in `finalizeExit`).** That mislabels an external `kill -9` / OOM as a clean stop and would never relaunch a hard-killed agent. Fixed: only pid's *own* teardown is deliberate (tracked via the `stopping` state), an external signal on a `running` service is a failure.

## Consequences

- `on-failure` is the schema default, so **every service now auto-restarts on failure by default** — the documented behaviour, but a real behavioural change from the (broken) prior state where nothing restarted. Opt out with `restart: {policy: never}`.
- `finalizeExit` gains an exit-disposition computation (deliberate vs unexpected; failure signature incl. external signals) shared by the relauncher and the crash-detector feed.
- The crash detector now counts process exits; its `proc:exit_*` deferral (ADR 0003 decision 4) is lifted.

## Verification

Verified against real pi 0.78.1 (receipt: `verification/scenarios/s10-restart.sh`): a real running pi `kill -9`'d (external) is relaunched under `policy: always` (new pid, fresh `agent_start`); repeated external kills drive `proc:signal_SIGKILL` into the crash detector and **quarantine** the service at the threshold (terminal). The policy/backoff/`max_consecutive`/reset matrix is pure logic, unit-tested with an injected clock + timers in `test/restart.test.ts` (not re-run against real pi, per the verification PLAN's pure-logic exclusion).

## Revisit when

- A trigger (cron/file_watch, ADR 0014/0015) needs to re-fire a *stopped* service vs a crashed one — keep "deliberate stop" and "relaunch" distinct so a scheduled run isn't mistaken for a crash recovery.
- pi grows a native supervisor/restart of its own → re-evaluate owning this at all.
