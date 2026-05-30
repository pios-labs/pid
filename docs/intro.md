# pios — Chapter 1: pid

*An introduction for the pi community*

---

## The 30-second version

`pid` is a supervisor for pi agents. You write a small YAML file describing an agent you want to run — when it should run, what it costs, when to stop it — and `pid` keeps it alive, watches what it does, and intervenes when things go sideways. Think of it as `systemd` for agents, except it actually understands what agents are: tokens, dollars, tool calls, and approval requests, not just stdout lines and exit codes.

It's the first piece of a longer project called **pios**. More on that at the end. For now, just think of `pid` as "the missing piece that lets you leave a pi agent running overnight without flinching."

---

## The problem, in three stories

Before the what, the why. These are real things that have happened to people running agents in the background.

### Story 1: The $400 morning

You set up a cron job: every night at 3am, run a pi agent to summarize yesterday's GitHub activity. It worked great for a week. Then one night the agent gets stuck in a loop, retrying the same OpenAI call 800 times because of an upstream blip it can't recover from. You wake up to a $400 invoice and zero work done. Your provider has no per-cron-job spending cap. systemd doesn't know what a "dollar" is.

### Story 2: The 240 identical failures

Your agent runs every five minutes to process new files in a directory. One day, a config change breaks the tool it depends on. It fails. systemd dutifully restarts it. It fails again. systemd restarts it again. By the time you check that evening, your logs have 240 identical failures, you've burned through a chunk of your token budget, and absolutely no work has been done. systemd can count restarts. It cannot tell that they all failed in exactly the same way.

### Story 3: The `rm -rf` you didn't see coming

You want your agent to clean up old build artifacts. You write a pi extension that lets it run bash. You leave it running. Some time later, the agent — through no malice, just an LLM doing its best — decides "old build artifact" includes a directory you needed. By the time you notice, the file is gone. pi has a beautiful approval-prompt system for exactly this case. It works perfectly when you're sitting in front of the TUI. It doesn't help when the agent is running headless on a server at 4am.

These three stories share something: pi can't solve them by itself, and `systemd` can't solve them either. Neither was built for the combination of "an LLM agent running unattended." That combination is what `pid` exists to handle.

---

## What `pid` actually is

A picture:

```
  ┌─────────────────────────────────────────┐
  │              pid daemon                 │   ← long-running, runs as you
  │  ┌─────────┐  ┌─────────┐  ┌─────────┐  │
  │  │ Service │  │  Event  │  │Approval │  │
  │  │  state  │  │ watcher │  │  inbox  │  │
  │  └─────────┘  └─────────┘  └─────────┘  │
  └────┬────────────────┬───────────────────┘
       │                │
       ▼                ▼
  ┌─────────┐      ┌─────────┐    ┌─────────┐
  │  pid    │      │   pi    │    │   pi    │   …
  │  CLI    │      │ subproc │    │ subproc │
  └─────────┘      └─────────┘    └─────────┘
```

In plain English:

- `pid` is **one long-running daemon process** on your machine. Started once, kept alive by your OS's own supervisor (systemd/launchd), runs as your user.
- For each agent you want to run, `pid` spawns **one `pi --mode rpc --session-id <service-name>` subprocess**. The subprocess is just pi running in headless mode with a stable session identity, so it can resume where it left off across restarts.
- `pid` **reads the event stream** that every pi subprocess emits (tokens, costs, tool calls, errors, approval requests). It writes events to a log and reacts to them.
- The **CLI** (`pid status`, `pid logs`, etc.) talks to the daemon over a Unix socket. The daemon does the work; the CLI is just a control plane.

Crucially: **`pid` does not modify pi**. It uses pi's documented RPC protocol and nothing else. If you uninstall `pid` tomorrow, your pi installation is untouched.

---

## What happens when you run `pid`

Let's walk through a complete first run.

**Step 1.** You install it:

```bash
npm install -g @pios-labs/pid
```

**Step 2.** You start the daemon. For a one-shot test you can just run it in the foreground:

```bash
pid daemon
# pid: daemon ready on /Users/you/.pi/pid.sock
```

In real use you'd put `pid daemon` under `systemd` or `launchd` so it survives reboots — `pid` is *not* a self-daemonizing process and that's intentional (let the OS do what it's good at). Example service files for both are in the repo.

What the daemon did during startup:

1. Created `~/.pi/pid/` as its own self-contained directory (services, state, logs, approvals, budgets all live under here — leaves room for sibling components like `~/.pi/pikg/` and `~/.pi/pifs/` later).
2. Read service definitions from `~/.pi/pid/services/*.yaml` (empty for now — you haven't defined any).
3. Opened a Unix socket at `~/.pi/pid/pid.sock` (mode 0600 — only readable by you).
4. Restored any services that were running before the last shutdown (none).

That's it. The daemon is now sitting there, idle, waiting for commands.

**Step 3.** Open a second terminal and check:

```bash
pid list
# {
#   "ok": true,
#   "data": []
# }
```

Empty. Nothing to supervise yet. Let's give it something.

---

## Your first service in five minutes

Create `~/.pi/pid/services/inbox-watcher.yaml`:

```yaml
name: inbox-watcher
cwd: ~/inbox
prompt: |
  Check ~/inbox/ for new files. Summarize each one,
  write the summary to ~/inbox/processed/, and move
  the original to ~/inbox/done/.

model:
  provider: zai
  id: glm-5.1

trigger:
  type: file_watch
  path: ~/inbox/

budget:
  daily_usd: 1.00
  on_exceed: pause

restart:
  policy: on-failure
  max_consecutive: 3
```

Walking through it:

- **`name`** must match the filename (`inbox-watcher.yaml` → `name: inbox-watcher`).
- **`cwd`** is where the agent will be launched (so `~/` expansion and relative paths work right).
- **`prompt`** is the initial instruction sent to the agent when it (re)starts. The agent then operates within whatever skills, AGENTS.md, and extensions pi finds in `cwd`.
- **`model`** specifies which LLM to use. `provider` is the pi provider name; `id` is the model ID. You can also set `thinking` level and `scoped` model lists for cycling. If omitted, pi uses whatever model it resolves from its own settings. See [Model Selection](./model-selection.md) for the full reference, including dynamic model switching.
- **`trigger`** says when to run. `file_watch` means "wake the agent up whenever a file appears in `~/inbox/`." Other options: `manual` (only when you run `pid start`), `cron` (a schedule like `"0 6 * * *"`).
- **`budget`** is the safety net. `daily_usd: 1.00` means "if the agent has spent more than $1 in API costs today, pause it until midnight." `on_exceed` can be `pause`, `quarantine` (no auto-resume), or `notify` (just log a warning).
- **`restart`** policy. `on-failure` restarts only if the agent exits non-zero. `max_consecutive: 3` means if it crashes three times in a row, give up.

Now enable and start it:

```bash
pid enable inbox-watcher    # mark it for auto-start on daemon boot
pid start inbox-watcher     # start it right now
pid status                  # what's running?
pid logs -f inbox-watcher   # follow its output, turn-grouped
```

The agent is now running. Drop a file into `~/inbox/` and watch the agent wake up and process it. If it crashes, `pid` restarts it. If it spends more than $1 today, `pid` pauses it. If it does anything you've marked for approval (we'll get to that), it'll wait for you to approve in `pid approvals`.

That's the whole loop.

---

## The three superpowers

These are the features that make `pid` worth installing over and above what `systemd` and vanilla pi already give you.

### 1. The cost governor

You declare a budget; `pid` enforces it.

```yaml
budget:
  daily_usd: 2.00
  weekly_usd: 10.00
  on_exceed: pause
```

What actually happens: every time the supervised pi subprocess emits a `message_end` event for an assistant message (the thing pi sends back after every LLM call), `pid` reads the cost from `event.message.usage.cost.total` and adds it to a running per-service spend total. The total is persisted in `~/.pi/pid/budget/<service>.json` so it survives daemon restarts. When the total crosses the threshold, `pid` sends `abort` to the subprocess and marks the service `paused`. At midnight UTC, the window resets and the service auto-resumes (or stays paused forever if you used `on_exceed: quarantine`).

You can see consumption any time:

```bash
pid budget inbox-watcher
# {
#   "service": "inbox-watcher",
#   "daily_usd": 2.00,
#   "spent_usd_window": 0.43,
#   "window_start": "...",
#   "window_end": "..."
# }
```

This is genuinely impossible with `systemd` (which doesn't know about money) or pi alone (which only tracks cost per session, not across many sessions of the same service).

### 2. Crash-loop quarantine

You declare what counts as "the same failure"; `pid` detects when it's happening too often.

```yaml
quarantine:
  same_failure_threshold: 3
  window_seconds: 300
```

When a pi subprocess fails, `pid` derives a "failure signature" from the event stream — something like `tool:bash:exit_127` if a bash command kept exiting with the same error, or `ext:my-extension.ts:tool_call` if an extension keeps throwing. If the same signature shows up three times within five minutes, `pid` quarantines the service: stops it, won't restart it, surfaces it on `pid status`, waits for you to type `pid unquarantine <name>` after you've fixed the underlying issue.

This is the difference between "your agent restarts forever burning tokens" and "your agent stops the moment it's clearly broken." `systemd` can count raw restarts but cannot tell that they all failed for the same reason. pi has its own auto-retry logic for transient errors but no concept of fleet-level "this agent is stuck and should give up."

### 3. The approval inbox

You declare which actions need human approval; `pid` routes the requests to one place.

```yaml
gate:
  - bash:rm
  - bash:git-push
  - write:outside_cwd
auto_approve:
  - read
  - grep
  - find
  - ls
```

This builds on a feature pi already has: extensions can emit `extension_ui_request` events to ask the user a question ("⚠️ Allow `rm -rf ./tmp`?"). When you're sitting in the TUI, pi pops a dialog. When the agent is headless, the request just sits there waiting for somebody to answer.

`pid` is that somebody. It collects every approval request from every supervised service into one queue:

```bash
pid approvals
# ID         SERVICE          METHOD   AGE   PROMPT
# abc12345   inbox-watcher    select   3m    Allow `rm -rf ./tmp`?
# def67890   morning-report   confirm  12m   Send email summary?
```

```bash
pid approve abc12345
# Allow `rm -rf ./tmp`?
# [1] Yes
# [2] No
# > 2
# ✓ Denied
```

Behind the scenes `pid` writes the matching `extension_ui_response` back to the subprocess's stdin and the agent continues. Per-service policies (`gate` and `auto_approve`) let you fine-tune: maybe `inbox-watcher` can `bash:rm` freely inside `~/inbox/` but `morning-report` needs to ask before deleting anything anywhere.

**A note on design intent.** This is deliberately *not* a per-action approval dialog. Per-action dialogs cause fatigue — users either YOLO past them or hit enter without reading, neither of which is safety. pid's gate is narrow by design: you opt specific patterns *in* via `gate:`, with `auto_approve:` covering the broad safe defaults. The recommendation is to gate sparingly (the half-dozen actions you genuinely don't want happening without a glance) and lean on process-level isolation between pid and the subprocesses for the broader "agent does something unexpected" safety story. If your gate list is growing past a dozen patterns, that's a signal to reach for `pikg` (capability-scoped tool access, coming in a future chapter), not to keep adding to gate.

This is the feature that lets you keep pi's "interactive YOLO" workflow *and* run agents safely unattended. Two different defaults for two different contexts, no fork of pi required.

---

## How to extend `pid` yourself

The honest answer is that v0 of `pid` has a small extension surface — and that's deliberate, to keep the supervisor small and trustworthy. Here's what you can do today, what's coming, and how the boundaries work.

### What you can do today

**1. Write service files.** This is the obvious extension. Every YAML file in `~/.pi/pid/services/` is a new agent you can supervise. Mix and match triggers, budgets, restart policies, and gates to model your workflow. There's no programming required.

**2. Write pi extensions, run them under `pid`.** This is the powerful one. `pid` doesn't restrict what pi can do inside a supervised session — pi's extension API works exactly as documented. So you can:

- Write a pi extension that adds a custom tool, ship it with your service, and `pid` happily supervises an agent using it.
- Write a pi extension that intercepts tool calls and adds custom logic; whatever it does becomes part of the event stream that `pid` observes (and acts on via `gate`/`auto_approve`).
- Write a pi extension that uses the `extension_ui_request` protocol to ask the user something; `pid` will route the question to your approval inbox automatically.

In effect, the union of pi's extension surface plus `pid`'s service surface is your customization toolkit. pi gives you per-session intelligence; `pid` gives you per-fleet policy.

### What's planned but not in v0

These are the genuinely interesting extension points that aren't there yet. If any of these excite you, that's a contribution waiting to happen:

- **Custom trigger types** — beyond cron, file-watch, and (soon) webhooks. Imagine `trigger: { type: github_pr, repo: ... }` or `trigger: { type: slack_mention, channel: ... }`.
- **Approval delivery channels** — beyond the CLI inbox. Slack DMs, mobile push, web dashboard.
- **Cost-adapter plugins** — for users on alternative billing models (per-token-bucket rates, prepaid pools, team quotas).
- **Notification sinks** — where "your agent paused" / "your agent quarantined" should land.

The shape of these plugin surfaces will be designed properly before v0.2. If you have opinions, this is the right moment to file an issue.

### Why the surface is small (on purpose)

A supervisor is load-bearing infrastructure. If `pid` is flaky, every supervised agent inherits the flakiness. So v0 deliberately keeps the configurable surface tiny — declarative YAML, a small set of triggers, a small set of policies — and pushes anything more dynamic into pi extensions where the surface is already mature. As the project earns trust, the extension surface will grow.

---

## Why a pi user should care

A simple test: do any of these apply?

- You have ever wanted to run a pi agent overnight or schedule one to fire on a timer.
- You have ever worried what your bill would look like if a background agent went off the rails.
- You have ever wished pi's TUI approval prompts worked when the agent was running headless.
- You have ever set up a cron job that runs an agent, then nervously checked the next morning to see what it did.
- You are excited by the idea of a fleet of small specialised agents — one watches inbox, one writes reports, one chases issues — instead of one big interactive session.

If two or more of those apply, `pid` is built for you.

If none of them apply — you only use pi interactively, sitting in front of the TUI, one session at a time — then `pid` adds nothing you need today. That's a valid place to be, and you can come back to this page when it stops being true.

---

## The bigger picture: pios

`pid` is chapter 1 of a longer project called **pios** — a small operating system around pi agents.

The framing came from a simple observation: pi is a beautifully minimal session runtime. It does one thing — run an agent in a session — exceptionally well, and pushes everything else out to extensions, skills, prompts, and themes. But once you want to run *fleets* of agents — many of them, persistent, triggered by external events, with budgets and policies and approval flows — you need a layer above pi that thinks about agents collectively. That's what pios is: the layer above pi that manages agents the way an operating system manages processes.

The chapters, sketched:

- **Chapter 1: `pid`** (this one) — supervises agents as long-running services with cost, crash, and approval policy.
- **Chapter 2: `pikg`** (planned) — a capability-scoped tool registry. Mount MCP servers system-wide, grant subsets of capabilities to individual services. "This service can call `git:read` but not `git:write`."
- **Chapter 3: `pifs`** (planned) — managed persistent state. Sessions, memory, skills, vector indices as a system service, addressable across agents.
- **Chapter 4: `pipipe`** (planned) — inter-agent IPC. Mailboxes, supervision trees, request/response between agents. Erlang-style supervision for LLMs.

Each chapter is independently useful — you can install `pid` without ever caring about `pikg` — but together they add up to "the OS for agents that nobody's built yet."

We're shipping `pid` first because it solves real pains today (the three stories above), and because it's the foundation everything else attaches to. If `pid` resonates, the rest will follow.

---

## Status, gotchas, getting involved

**Status.** v0 is a working preview. The CLI surface and service file schema are stable; internals may change before v1. Use it in personal projects; don't pin production to it yet.

**Gotchas.**

- Linux and macOS only in v0. Windows support is planned but out of scope for now.
- `pid` does not enforce CPU or memory limits — use `systemd` cgroups or `launchd` resource limits as the outer wrapper if you need that.
- Approval delivery is CLI-only in v0. Slack/web/mobile is coming in v0.2.
- `pid` requires `pi >= 0.75.4`. Older pi releases lack some of the RPC events the cost governor and crash detector rely on (notably `willRetry` on `agent_end`). Recommended: `pi >= 0.76.0` for `--session-id` support.

**Getting involved.**

- Star and watch the repo: https://github.com/pios-labs/pid
- File issues for bugs, design ideas, plugin surface requests
- PRs welcome — see `CONTRIBUTING.md`. Pre-1.0 means the bar for shipping is honesty and tests, not perfection.
- The `@pios-labs` org is at https://www.npmjs.com/org/pios-labs
- Project home: https://pios.dev

This is a small project run by humans (and the agents we trust to write some of the code). If you've read this far, you're our audience. Tell us what would make `pid` useful for you.

---

*Next chapter, `pikg`, when the time is right. For now, run `pid daemon` and let your agents earn their keep without keeping you up at night.*

---

# Changelog

### 2026-05-28 00:17 BST — Integrity check against pi v0.76.0

Four corrections applied during cross-referencing against pi source at commit `1e168a89`:

1. **Cost governor description**: "assistant message event" with "usage.cost" → "`message_end` event for an assistant message" with `event.message.usage.cost.total`. The event type is `message_end`, and cost is nested inside the `message` field. Source: pi RPC docs, `packages/ai/src/types.ts`.

2. **Subprocess spawn description**: `pi --mode rpc` → `pi --mode rpc --session-id <service-name>`. Pi 0.76.0 added `--session-id` which gives pid deterministic per-service session identity, resumable across restarts. Source: `packages/coding-agent/CHANGELOG.md`.

3. **`pid budget show`** → **`pid budget`**: Aligned with v0-spec.md command table which uses `budget <name>` without a `show` subcommand.

4. **Pi version requirement**: `pi >= 0.75` → `pi >= 0.75.4` (for `willRetry` on `agent_end` events), recommended `>= 0.76.0` (for `--session-id`). Source: `packages/coding-agent/CHANGELOG.md`.
