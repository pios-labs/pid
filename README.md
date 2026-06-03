# pid — the pi agent supervisor

> Run your pi agents in the background without the surprises.

`pid` supervises [pi](https://pi.dev) agents as long-running services. It restarts them when they crash, enforces per-service cost and token budgets, quarantines services stuck in failure loops, and routes any approval requests they make to a unified inbox.

If you've ever wanted to leave a pi agent running overnight, or schedule one to fire every morning, and were nervous about cost surprises, infinite loops, or destructive actions taken while you weren't watching — `pid` is the missing piece.

## Why pid

`systemd`, `launchd`, and `pm2` are excellent process supervisors but they were built for processes, not LLM agents. They see exit codes and stdout; they don't understand tokens, dollars, tool calls, or human-in-the-loop approval requests.

`pid` is built specifically for agents:

- **Cost governor** — declare per-service daily/weekly token and dollar budgets. `pid` enforces them in real time from pi's event stream, auto-pauses services that hit their cap, and resumes them at the next budget window. No more bill surprises from a 3am cron job.
- **Crash-loop quarantine** — detects "same failure N times in T window" and quarantines the service instead of restarting it forever. Distinguishes transient errors (worth retrying) from broken agents (worth stopping). Saves money and your patience.
- **Approval inbox** — every `extension_ui_request` from any supervised service routes to one place. Approve or deny destructive actions, large spends, or sensitive operations from your terminal, with per-service policy. Lets you keep pi's interactive YOLO ergonomics *and* run agents safely unattended.

None of these are possible with system daemons alone — they have no semantic awareness of what an agent is doing. None are built into vanilla pi either — pi is a session runtime, not a fleet operator. `pid` fills the gap.

## Quick start

```bash
npm install -g @pios/pid
pid daemon &           # start the supervisor (or use systemd; see below)
```

Define a service in `~/.pi/services/inbox-watcher.yaml`:

```yaml
name: inbox-watcher
cwd: ~/inbox
prompt: "Check ~/inbox/ for new files and process them per AGENTS.md"
trigger:
  type: file_watch
  path: ~/inbox/
budget:
  daily_usd: 2.00
  on_exceed: pause
restart: on-failure
gate:
  - bash:rm
  - bash:git push
```

Enable and start:

```bash
pid enable inbox-watcher
pid start inbox-watcher
pid status                    # all services at a glance
pid logs -f inbox-watcher     # tail, turn-aware
pid approvals                 # pending approval requests
```

## How it works

`pid` is a long-running daemon. For each running service it spawns one `pi --mode rpc` subprocess, consumes its JSONL event stream, and applies cost tracking, crash detection, and approval routing. Service state persists to disk, so `pid` recovers cleanly across its own restarts.

`pid` requires no changes to upstream pi. It uses pi's documented RPC protocol and extension hooks. The pi project is upstream; `pios/pid` is a separate distribution that depends on `@earendil-works/pi-coding-agent`.

## Running pid itself as a system service

We recommend running `pid` under your OS's own supervisor so it survives reboots.

`~/.config/systemd/user/pid.service`:

```ini
[Unit]
Description=pi agent supervisor
After=default.target

[Service]
ExecStart=/usr/local/bin/pid daemon
Restart=on-failure

[Install]
WantedBy=default.target
```

```bash
systemctl --user enable --now pid
```

A launchd plist for macOS is in `examples/launchd/`.

## What `pid` does NOT do (yet)

Explicit non-goals for v0, so you can tell if it's the right tool:

- Multi-host orchestration — single machine only
- CPU/memory limits (cgroups) — use systemd as the outer supervisor for those
- Web dashboard, Slack, or mobile delivery for approvals — CLI only in v0; richer delivery in v0.2
- Capability-scoped tool registry (planned as a separate component, `pikg`)
- Inter-agent IPC and mailboxes (planned: `pipipe`)
- Persistent cross-session memory (planned: `pifs`)
- Windows support — Linux and macOS in v0

If you need any of these now, `pid` isn't your tool yet. If you want a focused supervisor that solves three real pains today, you're in the right place.

## Project status

v0 is a working preview. The CLI surface and service file schema are stable; internal protocol may change before v1. Good for personal projects, not yet for production.

## Relationship to pi

`pid` is built and maintained independently of the upstream [pi](https://pi.dev) project. We depend on `@earendil-works/pi-coding-agent` as a published package and use only its documented RPC and SDK surfaces. We do not fork pi. Bug reports about pi itself should go to the [pi-mono](https://github.com/earendil-works/pi-mono) repo, not here.

## Contributing

Issues and PRs welcome. See `CONTRIBUTING.md`.

## License

MIT.
