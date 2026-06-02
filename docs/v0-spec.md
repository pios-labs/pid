# pid v0 — Design Spec

Status: draft for review.

This document defines the v0 scope, architecture, schemas, and protocol for `pid`, the pi agent supervisor.

**Minimum pi version:** `>= 0.75.4` (for `willRetry` on `agent_end` events). Recommended: `>= 0.76.0` (for `--session-id` flag and `excludeFromContext` on bash commands).

## Goals

1. Supervise pi agents as long-running services with crash recovery and clean lifecycle.
2. Enforce per-service cost and token budgets in real time, with auto-pause and scheduled resume.
3. Detect repeated-failure loops and quarantine offending services.
4. Route every `extension_ui_request` from every supervised service to a unified CLI approval inbox.
5. Require zero changes to upstream pi.

## Non-goals (v0)

- Multi-host orchestration
- Resource caps (CPU, memory, cgroups) — defer to outer OS supervisor
- Web / Slack / mobile approval delivery — CLI only; planned for v0.2
- Capability-scoped tool registry (`pikg`)
- Inter-agent IPC (`pipipe`)
- Persistent cross-session memory (`pifs`)
- Windows support — Linux + macOS only

## Architecture

```
┌─────────────────────────────────────────────────────────────┐
│                  pid daemon (long-running)                   │
│                                                              │
│  ┌────────────┐  ┌──────────────┐  ┌───────────────────┐    │
│  │  Service   │  │   Event      │  │ Approval router    │    │
│  │  registry  │  │   consumer   │  │                    │    │
│  │  + state   │  │   (per svc)  │  │                    │    │
│  └─────┬──────┘  └──────┬───────┘  └─────────┬──────────┘    │
│        │                │                    │               │
│        │       ┌────────▼─────────┐          │               │
│        │       │   Cost governor  │          │               │
│        │       │   Crash detector │          │               │
│        │       └──────────────────┘          │               │
│        │                                     │               │
│        │     Unix socket control plane       │               │
└────────┼─────────────────────────────────────┼───────────────┘
         │                                     │
   ┌─────▼──────┐                              │
   │  pid CLI   │                              │
   └────────────┘                              │
                                               │
         ┌────────────────────┬────────────────┘
         ▼                    ▼
   ┌──────────────┐    ┌──────────────┐
   │  pi subproc  │    │  pi subproc  │  ...
   │  --mode rpc  │    │  --mode rpc  │
   └──────────────┘    └──────────────┘
```

`pid` is a single Node.js daemon. It spawns one `pi --mode rpc` subprocess per running service. The daemon owns:

- a service registry loaded from `~/.pi/pid/services/*.yaml`
- per-service state (running / stopped / paused / quarantined, budget consumed, restart history, pending approvals)
- a Unix socket control plane at `~/.pi/pid/pid.sock` for the CLI
- one event consumer per running subprocess that parses JSONL from stdout
- the approval router that collects `extension_ui_request` and surfaces them on demand

State persists to `~/.pi/pid/state.json` on every meaningful change. On daemon restart, `pid` reads state and resumes services that were running, recovering budgets from their per-service files and re-holding quarantines. The approval inbox is **not** restored — it is in-memory and session-scoped (the re-spawned service re-asks; see "Product: approval inbox").

## Directory layout

```
~/.pi/                         # pi's existing top-level; pi owns ~/.pi/agent/
└── pid/                       # everything pid-owned lives under here
    ├── services/              # service definitions (YAML); watched for changes
    │   ├── inbox-watcher.yaml
    │   └── overnight-summary.yaml
    ├── state.json             # daemon state, atomic writes
    ├── logs/                  # per-service raw event streams
    │   ├── inbox-watcher.jsonl
    │   └── overnight-summary.jsonl
    ├── approvals/             # pending approval requests, one file per request
    │   └── <uuid>.json
    ├── budget/                # budget state per service
    │   └── inbox-watcher.json
    ├── pid.sock               # control plane socket, mode 0600
    └── pid.pid                # daemon pidfile
```

Why everything under `~/.pi/pid/` rather than scattered: keeps pid's footprint a single self-contained directory, leaves room for sibling components (`~/.pi/pikg/`, `~/.pi/pifs/`, etc.) to claim their own namespaces without collision, and makes "uninstall pid" a single `rm -rf ~/.pi/pid` operation. Override with `PID_HOME` env var.

## Service file schema (YAML)

```yaml
name: string                   # unique service name (required, matches filename stem)
command: string                # default: "pi"
cwd: path                      # working directory; supports ~ expansion
env: { KEY: value }            # extra environment variables
prompt: string                 # initial prompt sent on (re)start; optional

# Pi configuration — maps to pi CLI flags.
# pid always injects: --mode rpc --session-id <service-name>
# All fields optional; omit to use pi's defaults.
model:
  provider: string             # --provider (e.g., "anthropic", "zai", "openai")
  id: string                   # --model (e.g., "glm-5.1", "zai/glm-5.1")
  thinking: off | minimal | low | medium | high | xhigh   # --thinking
  scoped: [string]             # --models (patterns for cycling)

tools: [string] | false        # --tools <list> (universal allowlist) or --no-tools
no_builtin_tools: boolean      # --no-builtin-tools (keeps extension tools)
extensions: [string] | false   # -e <path>... (explicit list) or --no-extensions
skills: [string] | false       # --skill <path>... (explicit list) or --no-skills
context_files: false           # --no-context-files (skip AGENTS.md / CLAUDE.md)
system_prompt: string          # --system-prompt (replaces pi's default)
append_system_prompt: string   # --append-system-prompt (adds to pi's default)

args: [string]                 # extra pi CLI flags not covered above (default: [])
                               # conflicts with YAML fields above are rejected at load time

trigger:
  type: manual | cron | file_watch | webhook
  # type-specific fields:
  schedule: "0 6 * * *"        # cron expression (for cron)
  path: ~/inbox/               # path to watch (for file_watch)
  events: [add, change]        # which fs events (default: [add])
  port: 9000                   # for webhook (deferred to v0.2)

budget:
  daily_usd: number            # optional; default unlimited
  weekly_usd: number           # optional
  daily_tokens: number         # optional
  on_exceed: pause | quarantine | notify   # default: pause
  reset_tz: "UTC"              # default UTC

restart:
  policy: always | on-failure | never   # default: on-failure
  max_consecutive: 5           # circuit-break after N consecutive failures
  backoff:
    initial_ms: 1000
    max_ms: 60000
    factor: 2

quarantine:
  same_failure_threshold: 3    # N identical failures...
  window_seconds: 300          # ...within T seconds triggers quarantine

gate:                          # block-list: route the approval dialog for these to a human
  - bash:rm                    # (acts on an extension's confirm dialog, not the tool call itself —
  - bash:sudo                  #  see Product: approval inbox)
  - bash:git-push
  - write:outside_cwd
auto_approve:                  # patterns that bypass gating (auto-confirm)
  - read
  - grep
  - find
  - ls
```

Validation: a JSON Schema ships in the repo. `pid reload` reports schema errors per file and refuses to load invalid ones, leaving prior state untouched.

## Control plane protocol

The daemon listens on `~/.pi/pid/pid.sock`. CLI sends one JSON request per line; daemon responds with one JSON object per request. Optional `id` for correlation.

### Commands

| Command | Description |
|---|---|
| `list` | All services with summary status |
| `status <name>` | Detailed status for one service |
| `start <name>` | Start a stopped service |
| `stop <name>` | Stop a running service (closes pi's stdin for a clean `shutdown(0)` — dispose + final-output flush; SIGTERM→SIGKILL only if pi ignores it) |
| `restart <name>` | Stop + start |
| `resume <name> [--daily <usd\|none>] [--weekly <usd\|none>] [--daily-tokens <n\|none>] [--unlimited] [--reset]` | Resume a budget-paused service with an optional window-scoped override. Each `--daily`/`--weekly`/`--daily-tokens` sets that cap's ceiling for the current window (a number) or lifts it (`none`); other caps keep guarding. `--unlimited` lifts all caps this window; `--reset` zeroes the current windows under the original caps. No flags = resume under existing caps (re-pauses at once if still over). A bare `start` on a budget-paused service is refused — use `resume`. |
| `enable <name>` | Mark service for auto-start on daemon boot |
| `disable <name>` | Unmark; does not stop currently running |
| `logs <name> [-f] [--turns\|--raw]` | View/stream per-service logs |
| `tail` | Multiplexed live stream from all running services |
| `reload` | Re-read service files from disk |
| `approvals` | List pending approval requests |
| `approve <id> [--value <v>]` | Answer an approval request |
| `deny <id> [--reason <r>]` | Deny an approval request |
| `budget <name>` | Show budget consumed for a service |
| `budget reset <name>` | Force budget window reset |
| `quarantine <name>` | Manually quarantine a service |
| `unquarantine <name>` | Lift quarantine, allow restart |
| `version` | Daemon version |

### Example request/response

Request:
```json
{"id": "1", "cmd": "status", "name": "inbox-watcher"}
```

Response:
```json
{
  "id": "1",
  "ok": true,
  "data": {
    "name": "inbox-watcher",
    "state": "running",
    "pid": 14231,
    "started_at": "2026-05-26T22:15:00Z",
    "current_turn": 3,
    "tools_in_flight": ["bash"],
    "budget": {
      "daily_usd": 2.00,
      "spent_usd": 0.43,
      "reset_at": "2026-05-27T00:00:00Z"
    },
    "restarts_today": 0,
    "last_failure": null,
    "pending_approvals": 1
  }
}
```

## Event consumer

For each running service, `pid` spawns the subprocess and consumes its stdout JSONL. Every event is:

1. Appended to `~/.pi/pid/logs/<name>.jsonl` (raw, for replay/debugging)
2. Inspected by the cost governor (`message_end` where `event.message.role === "assistant"` → `event.message.usage.cost.total` → budget state)
3. Inspected by the crash detector (`tool_execution_end.isError`, `extension_error`, `agent_end` where last assistant message has `stopReason === "error"`)
4. Inspected by the approval router (`extension_ui_request` → enqueued; response routed back via stdin when answered)

Parsing follows pi's RPC framing rules: split on `\n` only, strip trailing `\r`. Do not use Node's `readline` (it splits on `U+2028`/`U+2029` which are valid inside JSON strings — see pi RPC docs).

## Product: cost governor

Per-service state in `~/.pi/pid/budget/<name>.json`:

```json
{
  "service": "inbox-watcher",
  "daily_usd": 2.00,
  "spent_usd_window": 0.43,
  "window_start": "2026-05-26T00:00:00Z",
  "window_end": "2026-05-27T00:00:00Z",
  "history": [
    {"date": "2026-05-25", "spent_usd": 1.87},
    {"date": "2026-05-24", "spent_usd": 0.92}
  ]
}
```

On every `message_end` event where `event.message.role === "assistant"`, extract `event.message.usage.cost.total` and add to `spent_usd_window`. If `spent_usd_window >= daily_usd`:

- Apply `on_exceed`:
  - `pause` — send `{"type":"abort"}` to subprocess, mark service as `paused`, set timer for `window_end` to auto-resume
  - `quarantine` — same but no auto-resume; requires manual `pid unquarantine`
  - `notify` — log a warning, do nothing else (useful for dry-run / observation mode)
- Emit a notification (CLI alert visible on `pid status`; v0.2 routes to delivery channels)

Window resets at `window_end` (UTC, or configured TZ).

## Product: crash-loop quarantine

Per-service state in memory + persisted:

```json
{
  "recent_failures": [
    {"at": "2026-05-26T22:14:00Z", "signature": "tool:bash:exit_127"},
    {"at": "2026-05-26T22:14:30Z", "signature": "tool:bash:exit_127"},
    {"at": "2026-05-26T22:15:00Z", "signature": "tool:bash:exit_127"}
  ]
}
```

Failure signature derivation:

| Event | Signature format | Notes |
|-|-|-|
| `tool_execution_end` with `isError=true` | `tool:<toolName>:error` | No structured exit code; use coarse signature. Optionally parse result text for finer granularity, but treat as best-effort. |
| `extension_error` | `ext:<extensionPath>:<event>` | Fields available directly on the event. |
| `agent_end` where last assistant message has `stopReason === "error"` | `agent:error` | `stopReason` is on `event.messages[last]`, not on `agent_end` itself. Only count when `event.willRetry === false` — pi handles its own retries internally. |
| Subprocess exit non-zero | `proc:exit_<code>` | From Node `child_process` exit event, outside pi's protocol. |

**Important:** `agent_end` events with `willRetry === true` must be ignored by the crash detector. These indicate pi's internal auto-retry for transient errors. Counting them would cause premature quarantine.

On each failure:
1. Compute signature, prepend to `recent_failures`, prune entries older than `quarantine.window_seconds`
2. Count occurrences of same signature in window
3. If count ≥ `quarantine.same_failure_threshold`, transition service to `quarantined`, stop subprocess, log reason, surface on `pid status`

`pid unquarantine <name>` clears failure history and allows restart.

## Product: approval inbox

> **What pid can and cannot do here (the load-bearing constraint).** pid can only answer an `extension_ui_request` — a dialog a pi extension explicitly raised. It **cannot veto a tool call**: `tool_execution_start` is informational (pi's in-process permission decision is already made), and there is no "deny tool" message on the RPC protocol. Tool gating therefore lives *inside pi*, in an extension's `tool_call` hook that calls `ctx.ui.confirm(...)` and enforces the answer. **pid is the policy/audit layer on top of that extension — not a tool firewall.** The broad "agent does something insane" safety net is process isolation (`cwd`, restricted user) and, later, `pikg`. Full reasoning in ADR 0004.

When the event consumer sees an `extension_ui_request` on stdout, it correlates the dialog with the tool currently **in-flight** for that service (a `tool_execution_start` with no matching `…_end` yet, i.e. the tool paused at its `tool_call` hook) to recover `toolName` + `args.command` for policy matching. A dialog with no in-flight tool is *free-standing* (a genuine question, e.g. a questionnaire extension) and is always enqueued.

Request fields vary by method:

| Method | Fields | Response format | Needs response? |
|-|-|-|-|
| `confirm` | `id`, `method`, `title`, `message`, optional `timeout` | `{ type, id, confirmed: boolean }` | yes |
| `select` | `id`, `method`, `title`, `options` (`string[]`), optional `timeout` | `{ type, id, value: string }` | yes |
| `input` | `id`, `method`, `title`, optional `placeholder`, optional `timeout` | `{ type, id, value: string }` | yes |
| `editor` | `id`, `method`, `title`, optional `prefill` | `{ type, id, value: string }` | yes |
| `notify` | `id`, `method`, `message`, `notifyType` (`info`\|`warning`\|`error`) | none (fire-and-forget) | no |

Fire-and-forget (no response): `notify`, plus `setStatus`, `setWidget`, `setTitle`, `set_editor_text`. Any dialog method can also receive a cancellation response: `{ type, id, cancelled: true }`.

Processing:

1. **Fire-and-forget** (`notify`, `setStatus`, …): log to the event stream, never enqueue (no response is expected; enqueuing would orphan it).
2. **`select` / `input` / `editor`**: always enqueue. There is no safe machine answer for a choice or free text, so policy does not auto-resolve these — a human picks the value.
3. **`confirm`** (the method tool-gating extensions use): apply per-service policy against the correlated command, **asymmetrically** (see "Matching" below):
   - command parses cleanly **and** every command head ∈ `auto_approve` → **approve** (reply `confirmed: true`).
   - else any whole-word token ∈ `gate` → **enqueue**.
   - else → **YOLO default**: approve (reply `confirmed: true`). With no `gate`/`auto_approve` config, pid behaves like bare pi.
4. On enqueue: hold the request in the in-memory inbox keyed by `id`, record the service + timestamp, and bump the service's `pending_approvals` counter. Log the decision to the per-service event log for audit.

**Matching (asymmetric — see ADR 0004).** Patterns are `tool` or `tool:command` (e.g. `bash`, `bash:rm`), matched on **structured whole words**, never substrings (so `bash:rm` never matches `alarm-cli`).

- **`gate` over-matches** (false positives are safe — you just get asked): a gated token counts if it appears as a whole word *anywhere* in the command. This even catches `$(echo rm)`, `X=rm; $X`, `xargs rm`.
- **`auto_approve` under-matches, fail-closed** (a false approval runs unattended): it fires only when the command parses cleanly into command heads **and every head is allow-listed**. Any substitution / variable command / `eval` / unparseable input → **bail to enqueue**. Blessed compounds are allowed (`auto_approve: [cd, rm]` approves `cd build && rm -rf *`); one unblessed or unresolvable head sinks the whole command.
- **Recommended pattern: a targeted `gate` block-list** of the destructive few (`bash:rm`, `bash:git-push`, `bash:dd`). Do **not** gate a whole tool and allow-list the safe commands — "bash is all you need" makes that list unbounded (fatigue). `gate` is best-effort visibility, **not** a security boundary; `find -delete` and obfuscation carry no matchable token. Isolation is the boundary.

`pid approvals`:

```
ID         SERVICE          METHOD   AGE   PROMPT
abc12345   inbox-watcher    select   3m    Allow `rm -rf ./tmp`?
def67890   morning-report   confirm  12m   Send email summary?
```

`pid approve abc12345` for select:

```
$ pid approve abc12345
Allow `rm -rf ./tmp`?
[1] Yes
[2] No
> 1
✓ Approved
```

- `confirm`: `pid approve <id>` → writes `{ type: "extension_ui_response", id, confirmed: true }`; `pid deny <id>` → writes `{ ..., confirmed: false }`
- `select`: `pid approve <id>` → prompts operator to pick from options, writes `{ type: "extension_ui_response", id, value: "<selected>" }`
- `input` / `editor`: opens `$EDITOR` for the response text, writes `{ type: "extension_ui_response", id, value: "<text>" }`
- `--value <v>` skips the interactive prompt and uses the supplied value directly
- `pid deny <id>` for any method → writes `{ type: "extension_ui_response", id, cancelled: true }`

On approve/deny: `pid` writes the response to the subprocess's stdin, removes the entry from the in-memory inbox, decrements the counter.

**The inbox is in-memory / session-scoped.** Pending approvals are **not** persisted for restart-survival: pid's pi children die with the daemon, so a persisted pending dialog would reference a dead process that can no longer be answered (replying over a fresh pi's stdin with a stale `id` is a no-op). On a daemon restart the queue is dropped and the re-spawned service simply re-asks; approval *decisions* are still written to the per-service event log for audit. If a request had a `timeout`, pi auto-resolves on its own clock — pid expires the inbox entry at the deadline and tells a late `pid approve` "too late" (it does not send a now-ignored response). *(This corrects an earlier "persist + re-attach" design; same reasoning as ADR 0003's in-memory crash window.)*

## Logging

Two log streams per service:

1. **Raw event log** (`~/.pi/pid/logs/<name>.jsonl`) — every event from the subprocess, append-only. Rotated when > 100 MB (`<name>.1.jsonl.gz` etc., 5 rotations retained).
2. **Human log** rendered on demand by `pid logs <name>`. Default view groups by turn:

```
[2026-05-26 22:15:01] turn 1
  user: Check ~/inbox/ for new files
  bash: ls ~/inbox/                          (0.2s)
  bash: cat ~/inbox/report.csv               (0.1s)
  assistant: Found 1 new file, summarizing...
  cost: $0.03

[2026-05-26 22:15:08] turn 2
  bash: write ~/processed/report-summary.md  (0.1s)
  assistant: Processed report.csv
  cost: $0.02
  total cost so far: $0.05 / $2.00 daily
```

`pid logs <name> --raw` falls back to JSONL. `--turns` is the default view. `-f` follows.

## Failure modes & recovery

| Failure | `pid` behavior |
|---|---|
| Subprocess crashes (exits non-zero) | Apply restart policy + crash-loop detection |
| Subprocess hangs (no events for `hang_timeout`, default 10min) | SIGTERM, treat as crash |
| Subprocess stdout has malformed line | Log warning, skip line, continue |
| `pid` daemon itself crashes | Outer supervisor (systemd) restarts; state.json restored; running services re-spawned |
| Disk full when writing state.json | Daemon refuses new mutating ops, surfaces error; existing subprocesses unaffected |
| Approval request times out | If request had `timeout`, agent auto-resolves per pi protocol; `pid` removes from inbox |
| Service file changes on disk | `pid reload` (or auto-reload if enabled) re-validates and applies; running service keeps current config until restart |

## Security posture (v0)

- Daemon runs as the invoking user; not root
- `~/.pi/pid/pid.sock` created with mode `0600`
- No network exposure
- Service files loaded only from `~/.pi/pid/services/` (no remote loading)
- API keys for pi subprocesses inherit from user env / `~/.pi/auth.json`; `pid` never reads them itself
- Approval files written with mode `0600`

## Open questions (decide before code)

1. **Trigger types in v0**: `manual` and `cron` are easy. `file_watch` needs `chokidar` or similar. `webhook` needs an HTTP server. Recommendation: ship `manual`, `cron`, `file_watch`; defer `webhook` to v0.2.
2. **Service file format**: YAML is most ergonomic, TOML is more constrained, JSON is universally parsed but verbose. Recommendation: YAML with JSON Schema validation.
3. **Notification channels in v0**: just `pid status` + stderr? Or also system notifications (libnotify, osascript)? Recommendation: stderr + status only for v0; channels in v0.2.
4. **Cost-per-tool-call gate (`spend:>1.00`)**: pi doesn't expose per-tool-call cost projection. Implementing would mean estimating cost before execution. Recommendation: defer to v0.2.
5. ~~**Directory layout**: resolved. Everything pid-owned lives under `~/.pi/pid/`, including services. No collision with pi's `~/.pi/agent/`.~~
6. **Daemon lifecycle**: should `pid daemon` daemonize itself (detach, fork, write pidfile) or stay foreground and expect to be supervised by systemd/launchd? Recommendation: **foreground only.** Daemonization is an OS supervisor's job. Document the systemd unit prominently.

## v0 milestone definition

Ship v0 when all true:

- [ ] Daemon starts, loads service files, supervises subprocesses with restart policy
- [ ] All CLI commands above implemented
- [ ] Cost governor enforces `daily_usd` with `pause` + auto-resume
- [ ] Crash-loop quarantine triggers on threshold, surfaces on `status`
- [ ] Approval inbox routes `extension_ui_request`; CLI approve/deny works
- [ ] State persists across daemon restart with no service interruption
- [ ] 3 example service files in `examples/`
- [ ] README + quickstart + 3-minute screencast
- [ ] Installable from npm
- [ ] systemd user unit + launchd plist included as examples
- [ ] Test suite covers supervisor, cost governor, crash detector, approval router
- [ ] One end-to-end smoke test that runs an actual pi subprocess

## Out-of-scope reminders (future versions)

- `pikg` — capability-scoped MCP tool registry
- `pipipe` — inter-agent IPC
- `pifs` — managed persistent state
- Multi-host / cluster
- Web UI / dashboard
- Slack / Telegram / mobile push delivery for approvals
- Replay / time-travel debugging
- Windows support

---

# Changelog

All amendments to this spec are recorded here with date, what changed, and why.

### 2026-05-28 00:17 BST — Integrity check against pi v0.76.0

Cross-referenced every technical claim against pi's source and docs at commit `1e168a89`. Also checked internal consistency across all three pid docs. Twelve corrections applied:

**Errors fixed (would have caused implementation bugs):**

1. **`agent_end` stop reason path**: Changed `agent_end with stopReason=error` → `agent_end where last assistant message has stopReason === "error"`. The `stopReason` field lives on the `AssistantMessage` inside `event.messages`, not on the `agent_end` event itself. Source: `packages/agent/src/types.ts`, `packages/coding-agent/src/modes/rpc/rpc-types.ts`.

2. **Service registry path** (line 59): `~/.pi/services/*.yaml` → `~/.pi/pid/services/*.yaml`. Pre-refactor path had leaked through. The directory layout diagram (line 68–85) already showed the correct path.

3. **Socket path** (lines 62, 142, 345): `~/.pi/pid.sock` → `~/.pi/pid/pid.sock`. Same pre-refactor leak. Three occurrences fixed.

4. **Security section service path** (line 346): `~/.pi/services/` → `~/.pi/pid/services/`. Same issue.

5. **Cost governor field path** (line 227): `usage.cost.total` → `event.message.usage.cost.total`, filtered by `event.message.role === "assistant"`. The cost is nested inside the `message_end` event's `message` field, not directly on the event. Source: `packages/ai/src/types.ts` (`Usage` interface), confirmed by regression test `3982-message-end-cost-override.test.ts`.

6. **Bash exit code signatures**: Changed `tool:bash:exit_127` to `tool:bash:error` (coarse). `tool_execution_end` has no structured `exitCode` field; the exit code is in human-readable result text. Heuristic parsing noted as optional best-effort. Source: `packages/agent/src/types.ts` (`ToolExecutionEndEvent`).

**Design gaps addressed:**

7. **`willRetry` filtering**: Added mandatory filtering of `agent_end` events where `willRetry === true`. These are pi's internal auto-retries for transient errors; counting them would cause premature quarantine. Added in pi 0.75.4. Source: `packages/coding-agent/CHANGELOG.md`.

8. **`--session-id` adoption**: Replaced `--no-session` default args with `--session-id <service-name>`. Gives pid deterministic session identity per service, resumable across restarts. Added in pi 0.76.0. Source: `packages/coding-agent/docs/rpc.md`.

9. **Minimum pi version**: Added `>= 0.75.4` requirement (for `willRetry`), recommended `>= 0.76.0` (for `--session-id` and `excludeFromContext`).

10. **`extension_ui_request` method variants**: Expanded the approval inbox section with per-method field tables. Request fields vary (`confirm` has `title`+`message`; `select` has `title`+`options`; `input` has `title`+`placeholder`; `notify` is fire-and-forget). Response formats vary (`confirmed: boolean` for confirm; `value: string` for select/input/editor; `cancelled: true` for denial). `notify` events logged but not enqueued. Source: `packages/coding-agent/src/modes/rpc/rpc-types.ts` (`RpcExtensionUIRequest`, `RpcExtensionUIResponse` union types).

**Internal consistency fixes:**

11. **Stale open question 5**: Marked as resolved. The directory layout already places everything under `~/.pi/pid/`, making the collision concern moot.

12. **Event consumer description**: Updated to show correct nested field paths for cost (`event.message.usage.cost.total`) and crash detection (`event.messages[last].stopReason`).

**Verdict:** pid's architecture is viable. All three v0 products are buildable on pi's current documented RPC protocol without upstream changes. Zero philosophical conflicts with pi's design. Zero duplication of existing pi features.
