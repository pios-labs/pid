# 0014 — Triggers as supervised jobs: `pid run` + native `file_watch`, cron delegated to the OS

- **Status:** Accepted
- **Date:** 2026-06-08
- **Deciders:** Steven (decision), Claude (analysis)

## Context

The `trigger:` block shipped in the schema with `manual` / `cron` / `file_watch` variants, but **no runtime ever fired a trigger** (a pre-launch audit caught this, same claim-vs-reality class as the prompt-delivery gap). Wiring it forces two questions: (1) what does a triggered service *do* when it fires, and (2) should pid own time-based scheduling at all.

**(1) Firing model.** A `pi --mode rpc` session is long-lived and takes successive `prompt` commands with shared context (`rpc.md` §Prompting); pi also ships a one-shot print mode (`pi -p` runs once, exits). So pi users already hold both mental models. For a *scheduled/event* trigger, the un-surprising reading — the one a pi/unix daily-driver expects from "cron"/"watch" — is a **job**: run the task fresh, finish, done (systemd `oneshot` + timer), not a 24/7 process that gets poked and accumulates a week of context.

**(2) Should pid schedule?** pid's value for a timed run is the *supervision* (cost ceiling, crash quarantine, approval inbox, observability), not the scheduling — `0 9 * * * pi -p "…"` already schedules; what it lacks is the guardrails. A hand-rolled cron matcher (DST, catch-up on missed runs while the daemon was down, correctness) is exactly the OS-native machinery our house rule says not to reinvent. System cron / launchd / systemd timers already nailed it.

## Decision

**Triggers are supervised jobs, and pid does not reinvent cron.**

- **`pid run <service>`** — a one-shot *supervised* job: start → run the prompt → auto-stop on the turn's end, with every guardrail (budget, approvals, in-session crash detection, observability) applied. Blocking by default (the daemon owns the job; the CLI returns the outcome with a real exit code), so it drops cleanly into any external scheduler: `0 9 * * * pid run morning-report`. This is the integration point and the cron replacement.
- **`file_watch`** stays a **native** trigger — the one worth owning: "wake the agent when a file lands" has no clean, consistent cross-platform OS primitive, and it composes with the supervision. On a matching filesystem event it launches the same supervised job (fire-and-forget; skip if a run is already in flight). Uses `fs.watchFile` polling, the same choice ADR 0008 already made for log tailing (cross-platform, rename/inode-safe).
- **`manual`** stays the **long-running** model (`pid start` → run, stay up) — unchanged. This is where the restart relauncher (ADR 0013) and proc-exit quarantine live.
- **Native `cron` is cut from v0** — *not deferred to a mythical version for its own sake*: removed with a reason (we don't out-cron cron), with a strictly better integration (`pid run` from the OS scheduler). The schema **rejects** `trigger: {type: cron}` loudly rather than accepting it as a silent no-op. A future "picron" may revisit owning the schedule (systemd-timer style) if it earns its place.

**Job vs long-running, precisely:**
- A **job** (`pid run`, `file_watch` fire): marked job-mode; auto-stops after `agent_end` (the turn completed); **excluded from the relauncher** — a job that crashes simply fails and waits for its next trigger, rather than being kept alive. In-session crash detection, budget, and approvals still apply during the run.
- A **long-running service** (`manual`): stays up; the relauncher keeps it alive and proc-exit loops quarantine it (ADR 0013).

This is the systemd split — `Type=simple` (long-running) vs `oneshot` + timer/path (job) — which every unix/pi user already understands.

## Alternatives considered

- **Standing session, poked on trigger** (a 24/7 pi process that gets `send({prompt})` each fire). Smallest code (reuses `send()`), but a daily-cron service then runs an idle process all night and "remembers" prior runs unless we `new_session` each fire — the inconsistency a sharp pi user spots immediately. The continuous-supervision upside it offered is already delivered by `manual` long-running services, so nothing is lost by making *triggers* mean *jobs*. Rejected as the trigger default.
- **Native cron matcher in pid** (systemd-timer style: schedule in the YAML unit). Defensible by systemd precedent and nice for one-file declarative config, but reinvents OS scheduling (our house rule) for marginal gain over `pid run` from cron. Deferred to a possible future "picron" — with a real reason, not a placeholder.
- **No native triggers at all** (delegate file-watch to launchd WatchPaths / systemd `.path` too). Purest small-tools take, but the OS file-event story is fragmented and awkward, and "wake on file drop" is genuinely pid-shaped. Kept `file_watch` native.

## Consequences

- New `pid run` command + daemon `run` dispatch; the supervisor gains a job lifecycle (`runJob`/`launchJob`, job-mode tracking, auto-stop on `agent_end`) layered over the existing start/stop.
- The `cron` schema variant is removed; the 7 example services that used it move to `manual` + a documented `pid run` crontab line. `inbox-watcher` stays on `file_watch`.
- Public messaging sharpens from "pid is another scheduler" to "**pid makes your scheduled agent safe to leave alone**."

## Verification

`pid run` and `file_watch` are each verified against real pi 0.78.1 (receipts: `verification/scenarios/s11-run.sh`, `s12-file-watch.sh`): a real one-shot job runs its turn and auto-stops; a real file event launches a supervised job. The job/long-running branching in the supervisor is covered by the existing supervisor tests plus these receipts.

## Revisit when

- A "picron" evaluation: if owning the schedule (declarative timer units, cross-platform, missed-run catch-up) proves worth the reinvention, revisit native time triggers — on top of `pid run`, not replacing it.
- If a trigger needs to pass event context to the agent (e.g. the changed file path templated into the prompt), design that as an extension of the job's prompt delivery.
