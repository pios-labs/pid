#!/usr/bin/env bash
# S12 (ADR 0014) — a real filesystem event fires a one-shot supervised job (the `file_watch` trigger).
# The service is never `pid start`/`pid run` — it is only enabled (which arms the watcher). Dropping a
# file into the watched directory is the ONLY thing that can make it run, so an agent_end in the
# chronicle proves the file event drove a real pi job; it then auto-stops (job semantics, ADR 0014).
#
# Expectation written BEFORE the run: enable arms the watcher (no run yet); after a file lands, within
# a poll cycle a job runs (real agent_end) and auto-stops (state stopped, no lingering pid).
set -euo pipefail
source "$(dirname "${BASH_SOURCE[0]}")/lib.sh"
scn_init s12-file-watch

statusf() { pcli status "$1" --json 2>/dev/null | node -e "try{const d=JSON.parse(require('fs').readFileSync(0,'utf8'));const v=d['$2'];process.stdout.write(v==null?'':String(v))}catch{}"; }

mkdir -p "$PID_HOME/inbox"
cat >"$PID_HOME/services/watcher.yaml" <<YAML
name: watcher
cwd: $PID_HOME/work
prompt: "Reply with exactly: PID-VERIFY-S12 and nothing else."
model:
  provider: zai
  id: glm-5.1
trigger:
  type: file_watch
  path: $PID_HOME/inbox
  events: [add]
YAML

start_daemon
# Enable arms the watcher (kill switch is disable). The service is NOT started — only watching.
pcli enable watcher >/dev/null
sleep 2
# Sanity: nothing has run yet (no file dropped) — the watcher is armed but idle.
BEFORE="$(node -e 'try{const e=require("fs").readFileSync(process.argv[1],"utf8").trim().split("\n").filter(Boolean);console.log(e.length)}catch{console.log(0)}' "$PID_HOME/logs/watcher.jsonl" 2>/dev/null || echo 0)"
echo "  chronicle lines before file drop: $BEFORE"

# Drop a file → the watcher should detect the add and fire a job.
echo "triage me" >"$PID_HOME/inbox/new-$(basename "$PID_HOME").txt"
wait_for watcher agent_end 80 || echo "  (warning: no agent_end after file drop)"
# Let the auto-stop settle.
for _ in $(seq 1 40); do [ "$(statusf watcher state)" != "running" ] && [ "$(statusf watcher state)" != "starting" ] && break; sleep 0.5; done
capture watcher

C="$CAP_DIR/s12-file-watch.jsonl"
[ "${BEFORE:-0}" = "0" ] && ok "watcher armed but idle until the file landed (no premature run)" || bad "service ran before any file event (lines=$BEFORE)"
assert "the file event fired a real pi job (agent_end)" "$C" "e.some(x=>x.type==='agent_end')"
assert "the run delivered the service's prompt"         "$C" "e.some(x=>x.type==='agent_end')&&JSON.stringify(e).includes('PID-VERIFY-S12')"
ST="$(statusf watcher state)"
PIDV="$(statusf watcher pid)"
[ "$ST" = "stopped" ] && ok "job auto-stopped after the turn (state=stopped)" || bad "expected stopped, got '$ST'"
[ -z "$PIDV" ] && ok "no lingering pi process" || bad "process still alive (pid=$PIDV)"

scn_done
