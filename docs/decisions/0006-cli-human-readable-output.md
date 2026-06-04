# 0006 — Human-readable CLI output by default; `--json` opt-out (the CLI render pass, D2)

- **Status:** Accepted
- **Date:** 2026-06-03
- **Deciders:** Steven (decisions), Claude (analysis)

## Context

pid's CLI (`src/cli.ts`) currently routes **every** command through one function — `callDaemon` (`cli.ts:164-175`) — which prints `JSON.stringify(response, null, 2)`. There is no human-readable rendering anywhere: `list`, `status`, `start`, `resume`, `approvals`, all of them emit the raw protocol envelope `{ id, ok, data | error }`.

Two problems:

- **Un-pi-like.** pi's own CLI defaults to human text and treats machine output as opt-in: `--mode <mode>` is `text (default), json, or rpc` (`pi/packages/coding-agent/src/cli/args.ts:238`, gated at `:79`). pi *never* defaults to a JSON blob — you ask for it. pid currently does the exact inverse.
- **Poor (and worsening) UX for the info commands.** `ServiceRecord` (`supervisor/index.ts:29-36`) embeds the entire parsed `ServiceConfig`, so `pid status` / `pid list` dump the whole service file back at the operator inline. Error receipts dump `{ ok:false, error }` as JSON, so a refused command makes the user read JSON to learn why.

This surfaced while scoping the approval-router CLI dispatch (increment D). The v0 spec frames `pid approvals` as a rendered **"Product: approval inbox"** (`docs/v0-spec.md:325`), which forced the question: is `approvals` a one-off pretty command, or is pid's whole output contract due a correction? Decided: the latter — fix the convention, don't special-case one command.

## Decision

**pid's CLI renders human-readable output by default and exposes the raw structured data behind a `--json` flag on every command** — mirroring pi's `--mode text|json|rpc` split (human default, machine opt-in).

- **Default = human-readable.** *Info* commands (`list`, `status`, `approvals`, `budget show`, …) render scannable tables / labeled blocks; *action* commands (`start`/`stop`/`restart`/`resume`/`enable`/`disable`/`quarantine`/`unquarantine`/`reload`/`approve`/`deny`) print a one-line receipt; errors print a plain message to **stderr** with a non-zero exit code (no JSON envelope).
- **`--json` = the structured payload the daemon already returns** — the protocol `data` (or `{ error }` on failure). This is the stable contract for dashboards, scripting, and downstream systems, and it is the *same* data the observability dashboard will consume. Rendering never changes the data, only the terminal presentation.
- **Rendering is client-side only.** The daemon, the Unix-socket protocol, and the router are **unchanged** — they remain a pure structured-data control plane. All presentation lives in `cli.ts` plus a small pure formatter module. No new daemon command; no protocol change.
- **Pure, testable formatters.** Each renderer is a pure `format*(data, now?) → string`, matching the codebase's pure-core-plus-pinned-test idiom (`matcher.classify`, the crash detector's `deriveSignature`, the cost extractor). `now` injection (for relative `AGE`-style columns) mirrors the router's `now?: () => number` (`approvals/router.ts:104`).

### Why (the four reasons, recorded)

1. **Most pi-like** — matches pi's human-default / JSON-opt-in convention exactly.
2. **Best UX** — operators read these commands to decide a next move; a table beats a config-laden JSON blob, and an error beats `{ok:false,...}`.
3. **Cross-app consistency** — one output contract across every pid command, not one pretty command among blobs.
4. **Still machine-friendly** — `--json` preserves the raw structured output for dashboards / downstream systems, so we lose nothing.

## Sequencing & scope

- **This is increment D2, built immediately after D1.** D1 = the approval-router CLI dispatch (wire `approvals` / `approve` / `deny` in `daemon.ts:71-76` to the supervisor's already-built `listApprovals` / `approveRequest` / `denyRequest`) **plus** rendering the approval inbox table and approve/deny receipts — because the inbox is D1's product surface and the spec demands it. D1 therefore establishes the render + `--json` pattern for *one* command; **D2 generalizes that exact pattern across the remaining commands.**
- **Deliberately out of scope for this ADR** (these are D2 *implementation* decisions, not contract): the exact column layout / wording per command, whether any command needs bespoke rendering, color / TTY-detection, pagination, and the relative-time format. This ADR fixes the **requirement and the contract** (human default, `--json` opt-out, client-side, pure formatters) — not the pixels.

### Two approval-inbox UX decisions folded into D2 (forks 2 & 3, settled 2026-06-03)

- **Value entry for `select`/`input`/`editor` (fork 2).** **D1** ships the functional floor: `pid approve <id> --value <v>`, with `select` values validated **fail-closed** against the dialog's `options`, and a helpful guard (listing the options / placeholder) when `--value` is omitted on a non-`confirm` dialog. **D2** adds the interactive ergonomics: a numbered picker for `select`, a one-line prompt for `input`, and **`$EDITOR` for `editor`** — the last mirroring pi's own `modes/interactive/components/extension-editor.ts` (`$VISUAL || $EDITOR` precedence, temp-file → `spawn` with `stdio:"inherit"` → read back only on exit 0, the "no editor configured" guard). `confirm` (the dominant, tool-gating method) needs no value and is complete in D1. **Interactive ≠ TUI:** these are one-shot prompts / an editor breakout, not a full-screen redraw app — so no TUI machinery is introduced (the plain-CLI-over-a-documented-contract posture is deliberate; a TUI/GUI, if ever wanted, is a separate downstream consumer of `--json` + the log chronicle, not a change to pid core).
- **`pending_approvals` on `pid status` (fork 3).** `status` gains a **derived** count of in-flight approvals per service — computed on read from the router's inbox, **never a stored counter** (the inbox already is the source of truth, so a separate tally would only drift). Surfaced in the rendered status block and in `--json`. **Scoped to the count only** (not a full budget-spend block — the `paused` state already signals budget, and `budget show` gives detail). Solves the "a blocked agent still reads as `running`" blind spot. Lands in **D2** with the status view; **D1 does not touch `status`**. (Acceptable because D2 follows D1 immediately and go-live requires D2 — the split is engineering hygiene, not a shippable-without-it call.)

### Command/UX taxonomy (scopes D2 for the implementer)

The job of each command, and whether the operator *decides something* from its output:

|Command | Job | Info / action | Operator decides next? |
|-|-|-|-|
|`list` / `ls` | what services exist + state | info | yes → start/stop/resume |
|`status [name]` | detailed state of one/all | info | yes → paused? quarantined? over budget? |
|`approvals` | pending dialogs | info → action | **yes (the point)** → which id to approve/deny |
|`budget show` | spend vs caps | info | yes → resume / raise cap |
|`logs` / `tail` | event stream | info (stream) | situational |
|`start`/`stop`/`restart` | change run state | action | no — receipt |
|`resume` | lift budget pause | action | no — receipt (+ caps now applied) |
|`enable`/`disable` | toggle auto-start | action | no — receipt |
|`quarantine`/`unquarantine` | toggle terminal hold | action | no — receipt |
|`reload` | re-read service files | action | no — receipt (what changed) |
|`approve`/`deny` | answer a dialog | action | no — receipt |

The **info** commands gain the most (they're human-scanned and their raw dumps are worst — `status`/`list` inline the whole config); the **action** commands need only a tidy receipt.

## Alternatives considered / rejected

- **Status quo + render only `approvals`.** Rejected: leaves one pretty command among JSON blobs — the *least* consistent outcome, and keeps pid permanently un-pi-like.
- **`--pretty` opt-in (keep JSON default).** Rejected: consistent, but enshrines the un-pi-like JSON default — the opposite of pi's convention. For a human-run CLI, human-readable is the right default; machines ask for `--json`.
- **CLI as a pure machine bridge; the dashboard is the only human surface.** Rejected: the operator lives in the CLI today, before any dashboard exists — `pid status` / `pid approvals` are read by people now. A human CLI + `--json` serves both the person and the future dashboard without privileging one.
- **Fold the CLI-wide render into D1.** Rejected (BAP — one reviewable idea per increment): D1 = "make the approval inbox work"; D2 = "make the CLI human-readable." Bundling buries a cross-cutting presentation change inside the router-dispatch commit — the same reasoning by which ADR 0005 pulled the log envelope out *ahead* of the router.

## Consequences

- A new small module for the formatters (e.g. `src/cli-render.ts`) — a new abstraction, directed by Steven (BAP / compounding-booboos: surfaced and decided, not slipped in). `cli.ts`'s single `callDaemon` JSON-dump path is replaced by per-command rendering plus a shared `--json` short-circuit.
- A global `--json` option (commander, program-level or per-command) that short-circuits to print the daemon's `data` (or `{ error }`) verbatim.
- Tests: pure formatter tests (pinned sample input → expected string), mirroring the existing pure-core tests. The `--json` path reproduces today's behavior, so it is regression-safe.
- pid is pre-1.0; the JSON **envelope is not changing** (it is already what the daemon returns), so `--json` consumers see today's data. Only the default *human* output is new.

## Amendment (2026-06-04, D2(a)+(c) implementation)

Implementing fork-3 surfaced a tension between two clauses of this ADR: fork-3 requires the
`pending_approvals` count "in `--json`", while Consequences says "the JSON envelope is not
changing". Resolved (Steven, BAP fork-1): the count is a **small additive field** on the status
payload, not an envelope change. `Supervisor.status()`/`list()` now return a
`ServiceStatus extends ServiceRecord { pendingApprovals: number }` **view** — the count is computed
live from the approval router on every read (never stored on `ServiceRecord`), so `--json` and the
human render derive from one payload (preserving the "same data, many renderings" invariant this ADR
is built on). The join lives in the supervisor (the composition root that already owns the records
*and* the router), not in the daemon dispatch (kept thin) nor the CLI (which would split the human
and machine views). `--json` consumers see today's data **plus** `pendingApprovals` — additive, no
removals or renames.

Layout (fork-2, the "pixels" this ADR deferred): `list` and `status`-all share a lean
NAME/STATE/PID/UPTIME/PENDING table; `status <name>` is a labeled detail block with a `why` line
gated on `lastFailure` (so a crash/quarantine shows its signature; a budget `paused` does **not**
add a why line — that honours fork-3's "count only, no budget-spend block on status"). Action
commands print a `✓ <verb> <name> [→ <state>]` receipt, mirroring D1's approve/deny receipts. The
not-yet-implemented stubs (`logs`/`tail`/`reload`/`budget show|reset`) stay on the old JSON-dump path
until their features land — they are out of this render pass's scope.

## Revisit when

- The dashboard / index lands → confirm `--json` is the CLI-side ingestion contract and keep it from drifting from the daemon's structured `data` and the log envelope (ADR 0005).
- A command needs a structured sub-view or live mode (e.g. `status --watch`) → still render client-side; never push presentation into the daemon.
- A second front-end appears (web/Slack/mobile approval delivery, slated for v0.2 per the spec) → it consumes the same `--json` / protocol data, not the human renderer.
