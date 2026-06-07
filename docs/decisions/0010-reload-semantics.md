# 0010 — `pid reload`: service-set reconciliation, never interrupting running work

- **Status:** Accepted
- **Date:** 2026-06-07
- **Deciders:** Steven (decisions), Claude (analysis)

## Context

`pid reload` has shipped as a CLI command and a daemon dispatch case since the scaffold, but the case throws `not implemented` — it is one of three remaining stubs (`reload`, `budget show`, `budget reset`). It surfaced as a prerequisite while scoping the observability **example dashboard** (ADR 0008 D4): the dashboard's design goal is to expose *every* operational command over HTTP (the "kitchen-sink" reference), so the surface it mirrors must actually work. `reload` is the one stub that is a genuine **feature** rather than a few lines of dispatch glue — it needs a reconciliation design and, critically, a rule for what happens to a **running** service when its definition changes underneath it.

A pid service is defined by a YAML file in `servicesDir()`; the daemon discovers the set on boot via `loadAllServices()` and holds one `ServiceRecord` per service in an in-memory `Map` (`src/supervisor/index.ts`). Runtime state that is *not* in the YAML — the `enabled[]` / `quarantined[]` sets (`state.json`), per-service budget windows (`budget/<name>.json`), and the live approval inbox — lives outside the config. `reload` must re-read the YAML set without restarting the daemon, and decide how new / removed / modified definitions reconcile against the live registry.

The open question that blocked a casual implementation: **what happens to a service that is running when its YAML changes or is deleted?** We answered it by cross-referencing pi's own `/reload` (the mandated mirror-before-building discipline), which solves the exact same problem one level down (a long-lived session whose disk-loaded runtime changes).

### pi cross-reference (read-only clone @ `dc7b547f`, 2026-06-03)

pi's `/reload` is a **runtime swap on a live session**: the conversation/session survives; only the disk-loaded runtime (extensions, skills, prompts, themes, keybindings, settings) is rebuilt. `agentSession.reload()` (`core/agent-session.ts:2429`):

1. snapshots carry-over state — `getFlagValues()` preserves user-set extension flags across the swap;
2. tears the old runtime down cleanly — emits `session_shutdown` (`reason: "reload"`) to every current extension;
3. re-reads everything from disk — `settingsManager.reload()`, `resetApiProviders()`, `resourceLoader.reload()`;
4. rebuilds the runtime — re-imports extensions, restoring the captured flag values;
5. re-announces — `session_start` (`reason: "reload"`) + re-discovers extension-contributed resources.

Two mechanics decided pid's design:

- **Discovery is a full re-scan, not an incremental diff.** `resourceLoader.reload()` (`core/resource-loader.ts:321`) clears its arrays and re-reads the skill/prompt/theme directories from disk (`readdirSync`). Presence on disk *is* the source of truth. Modified extension source is genuinely re-evaluated: extensions load through a `jiti` instance created fresh per load with **`moduleCache: false`** (`core/extensions/loader.ts:333`), so a changed file is re-read, never served stale.
- **Reload never interrupts running work.** Two distinct guards:
  - **User-triggered `/reload` is gated on quiescence.** `handleReloadCommand()` (`modes/interactive/interactive-mode.ts:4928`) refuses outright while `isStreaming` or `isCompacting`: *"Wait for the current response to finish before reloading."*
  - **Programmatic `ctx.reload()` (callable mid-handler) uses old-frame isolation.** Per `docs/extensions.md` (~1190): the currently-running handler continues in the old call frame; code after `await ctx.reload()` still runs the pre-reload version; only *future* commands/events/tool calls use the new version. Guidance: *"treat reload as terminal."* Even a *removed* extension's in-flight handler runs to completion; only the next call finds it gone.

The decisive lesson: **pi keeps a removed/changed thing alive only for as long as it is actively in use (an in-flight frame); the swap affects only the next invocation.** A removed extension does not linger as a flagged-but-stopped tombstone — once its in-flight frame returns, it is simply gone.

## Decision

`pid reload` re-runs `loadAllServices(servicesDir())` and **reconciles** the in-memory registry against disk, treating disk presence as truth (direct mirror of pi). Its governing principle, taken straight from pi:

> **Reload reconciles definitions and never interrupts running work. A running service always finishes on the definition it was started with; a changed definition takes effect on its next start.**

### 1. Reconcile by disk presence; the running process is the "in-flight frame".

| A service whose YAML is… | `reload` does |
|-|-|
| newly present | register it → appears in `list`, startable |
| removed, not running | deregister → gone from the registry |
| removed, **running** | flag `orphaned` (removed-on-disk); log `pid_config_changed`; **the live process is NOT killed**; it is no longer startable/restartable |
| modified, not running | update the stored definition → applies on next start |
| modified, **running** | update the *staged* definition; the live process keeps its old config; log `pid_config_changed` + set a `configChanged` status flag ("restart to apply"); **never auto-restart** |
| unchanged | no-op |
| runtime state (`enabled`/`quarantined`/budget/approvals) | **preserved** — it lives in `state.json` / `budget/<name>.json`, not the YAML, so a YAML re-read leaves it intact (pid already separates config from state, exactly as pi separates resources from session) |

"Modified" is detected by comparing the freshly-parsed `ServiceConfig` to the held one (structural equality over the validated config — see Consequences).

*Mirror:* full re-scan over incremental diff (pi's `resourceLoader.reload`); disk presence as truth; runtime state carried across the swap (pi's flag-value snapshot).

### 2. A removed-while-running service is deregistered on its next stop (not kept as a tombstone).

When a running service's YAML is deleted, the live process keeps running, flagged `orphaned`. The moment it stops — **for any reason** — it is deregistered and forgotten (absent from `list`).

This is the faithful mirror of pi: the running process is the in-flight frame, and pi keeps a removed thing only until its frame completes, then drops it. It is also internally consistent with pid's restart machinery for free: **an orphan has no definition on disk, so auto-resume and auto-restart have nothing to start from — an orphan can never come back, which makes *every* stop of an orphan terminal.** There is therefore no stop-reason classification to get wrong (a budget pause cannot resume an orphan either), and no zombie "stopped, unstartable, unclearable" entry lingering in `list` until a daemon restart.

*Rejected — keep the orphan as a flagged-stopped tombstone (the "leave running, flag orphaned, user clears it later" option):* it keeps state pi would never keep — a stopped service with no backing file sitting in `list`, unstartable and only removable by restarting the daemon. It also needs new surface (a command to clear the tombstone). Deregister-on-stop self-cleans with no new surface.

*Rejected — stop the process as part of reload (kill on removal):* turns `reload` into a kill switch and violates the never-interrupt-running-work principle. A config-management read should not terminate live agents.

### 3. A modified running service stages its config; the change is visible, never silently auto-applied.

The new config updates the staged definition and takes effect on the next start. Until then the divergence is surfaced two ways (congruent with the observability mandate): a `pid_config_changed` event in the service's chronicle, **and** a `configChanged` flag on `pid status` ("config changed — restart to apply"). `reload` never restarts a running service to apply config.

*Mirror:* pi's old-frame isolation — the running frame keeps old code; the change applies to the next invocation.

*Rejected — auto-restart to apply:* most "live", but breaks the isolation principle (reload interrupts running work to apply config) and can surprise an operator into killing an agent mid-task by editing a file. Visibility + an explicit `pid restart` keeps the human in control (the compounding-booboos discipline).

*Rejected — event only, no status flag:* the pending divergence would be visible in the log/dashboard but not in `pid status`, where an operator most expects it. Steven chose event + status flag.

## Scope / deferral

- **No config hot-swap into a live process.** Out of scope by Decision 3 — and not desired. A running service applies new config only on restart.
- **No incremental/granular reload** (e.g. "reload just one service"). `reload` reconciles the whole set in one pass, mirroring pi's whole-runtime reload. A targeted reload can be added later if a need appears.
- **No file-watching / auto-reload.** `reload` is explicit (a command), like pi's `/reload`. An optional watch-the-dir auto-reload is a separate, deferrable feature (wing test — explicit reload covers the acute need).
- **`pid_config_changed` is emitted only for *running* services.** A new / removed-not-running / modified-not-running service has no live chronicle stream to write to (consistent with ADR 0007: an action on a service with no stream has nowhere to log). The overall reconcile summary is carried by the `reload` command's own response, not the chronicle.
- **`add` (a `pid add` command) remains out of scope** — services are still authored as YAML files dropped into `servicesDir()`, then picked up by `reload`. A write/validate command is its own future feature + ADR.

## Consequences

- **Supervisor gains a `reload(load: LoadResult)` reconcile method** (the daemon re-reads disk and hands it in, mirroring how the initial `LoadResult` is injected at construction — keeps the supervisor filesystem-light). It diffs the new set against `this.services`, applies the table in Decision 1, registers/deregisters with the crash detector, approval router, and (re-)wires the cost governor for newly-budgeted services, and returns a structured summary (`added`/`removed`/`updated`/`orphaned`).
- **`ServiceRecord` gains two flags:** `orphaned?: boolean` (removed-on-disk, still running) and `configChanged?: boolean` (modified while running, restart to apply). Both are runtime-only, surfaced on the `ServiceStatus` view and rendered on `pid status`/`list`.
- **`finalizeExit` learns the orphan rule:** when an `orphaned` service's process exits, deregister it (drop from `services`, crash detector, approval router) instead of leaving a `stopped` record.
- **A new documented synthetic event `pid_config_changed`** joins the `pid_*` contract (ADRs 0004 §11, 0007), written via the existing `logPidEvent` helper. Payload: `{ change: "modified" | "removed", by: "reload" }` (the running-service cases). Added to the v0-spec "Log line schema".
- **Daemon `reload` dispatch is wired** (no longer `not implemented`); it loads from disk and calls the supervisor method.
- **CLI `reload` moves onto the ADR-0006 convention:** a human-readable reconcile receipt (what was added/removed/updated/orphaned) with a `--json` opt-out, replacing the raw `callDaemon` path. `status`/`list` rendering shows the `orphaned` / `configChanged` flags.
- **Config equality** is computed structurally over the validated `ServiceConfig` (a deterministic deep compare). Cheap at v0 set sizes; no hashing/index needed.

## Revisit when

- A targeted `pid reload <name>` is wanted → add it alongside the whole-set reconcile.
- File-watching auto-reload becomes a real need → add an opt-in watcher that calls the same reconcile.
- `pid add` / config authoring over the CLI lands → reconcile stays the pickup mechanism; revisit whether `add` should implicitly reload.
- pi changes its reload model (e.g. drops the quiescence gate, or adds live hot-swap) → re-read the source and reconcile pid's mirror.
