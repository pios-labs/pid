#!/usr/bin/env bash
# S8 (CP6) — the example dashboard FACADE rendered from a REAL daemon + real services.
# The facade (examples/dashboard/server.mjs) is a pure CLI consumer (ADR 0011 §2): it shells
# `pid tail --raw` for the live stream and `pid … --json` for snapshots/actions, nothing else. CP6
# proves that, pointed at a real running daemon, it faithfully relays real chronicle events
# (pi events + pid_* synthetic events), real snapshots, and POST actions over its HTTP/SSE surface.
#
# Expectation written BEFORE the run: GET /api/version → {api:1}; GET /api/services → real list;
# the SSE /api/events stream carries a `snapshot` (services[]) + `log` frames including a real pi
# event, a pid_budget_pause (a budgeted service breaches), and a pid_service_exit (a bad-command
# service); a POST action (budget reset) mutates the real daemon.
set -euo pipefail
DIR="$(dirname "${BASH_SOURCE[0]}")"
source "$DIR/lib.sh"
scn_init s8-dashboard

PORT=17878
SSE="$PID_HOME/sse.txt"
FACADE_PID=""
SSE_PID=""
# Tear down the facade + SSE curl on top of the lib's daemon/dir cleanup.
trap 'kill ${SSE_PID:-} ${FACADE_PID:-} 2>/dev/null; scn_teardown' EXIT

# PID_BIN wrapper so the facade drives THIS build against THIS PID_HOME (both inherited by its children).
cat >"$PID_HOME/pid-bin.sh" <<SH
#!/usr/bin/env bash
exec node "$REPO/dist/cli.js" "\$@"
SH
chmod +x "$PID_HOME/pid-bin.sh"
export PID_BIN="$PID_HOME/pid-bin.sh"

# Define the services BEFORE the daemon boots (it only knows services present at startup); they are
# trigger:manual so nothing runs until we explicitly `pid start` them — after the SSE stream is open.
cat >"$PID_HOME/services/bud.yaml" <<YAML
name: bud
cwd: $PID_HOME/work
prompt: "Reply with exactly: PID-VERIFY-S8 and nothing else."
model:
  provider: zai
  id: glm-5.1
budget:
  daily_tokens: 50
  on_exceed: pause
YAML
cat >"$PID_HOME/services/dead.yaml" <<YAML
name: dead
cwd: $PID_HOME/work
command: /nonexistent-pid-binary-xyz
prompt: "noop"
YAML

start_daemon

# Launch the facade (background) and wait until it answers.
node "$REPO/examples/dashboard/server.mjs" --port "$PORT" --host 127.0.0.1 >"$PID_HOME/facade.log" 2>&1 &
FACADE_PID=$!
ready=0
for _ in $(seq 1 50); do
	curl -fs "http://127.0.0.1:$PORT/api/version" >/dev/null 2>&1 && { ready=1; break; }
	sleep 0.2
done
[ "$ready" = 1 ] && ok "facade up; GET /api/version answered" || { bad "facade never came up"; cat "$PID_HOME/facade.log" >&2; }

# Open the SSE stream BEFORE the work happens, so live `log` frames are captured.
curl -sN "http://127.0.0.1:$PORT/api/events" >"$SSE" 2>/dev/null &
SSE_PID=$!
sleep 1

# Start the budgeted service: real spend → breach → pid_budget_pause flows through the stream.
pcli start bud >/dev/null
wait_for bud pid_budget_pause 80 || echo "  (warning: no pid_budget_pause)"

# Start the bad-command service → abnormal exit → pid_service_exit synthesized (ADR 0012); start() rejects.
pcli start dead >/dev/null 2>&1 || true
wait_for dead pid_service_exit 30 || echo "  (warning: no pid_service_exit)"
sleep 2  # let the SSE stream flush the last frames

kill "$SSE_PID" 2>/dev/null || true
SSE_PID=""

# Persist the source chronicles as committed receipts (the SSE dump lives in PID_HOME, torn down at exit).
# Distinct names: the lib's capture() always writes $SCN.jsonl, so copy each explicitly.
cp "$PID_HOME/logs/bud.jsonl"  "$CAP_DIR/s8-dashboard-bud.jsonl"
cp "$PID_HOME/logs/dead.jsonl" "$CAP_DIR/s8-dashboard-dead.jsonl"
{
	echo "scenario:      s8-dashboard (facade fed by a real daemon)"
	echo "pi:            $(pi --version 2>&1)"
	echo "ref-clone:     $(git -C "$REPO/../pi" rev-parse --short HEAD 2>/dev/null)"
	echo "source:        real pi run via the dashboard facade (examples/dashboard/server.mjs)"
	echo "captures:      s8-dashboard-bud.jsonl (pid_budget_pause), s8-dashboard-dead.jsonl (pid_service_exit)"
} >"$CAP_DIR/s8-dashboard.meta"
echo "  capture → s8-dashboard-bud.jsonl + s8-dashboard-dead.jsonl"

# ── Reads over HTTP ──
VER="$(curl -fs "http://127.0.0.1:$PORT/api/version" 2>/dev/null || echo '{}')"
echo "$VER" | node -e 'const d=JSON.parse(require("fs").readFileSync(0,"utf8"));process.exit(d.api===1&&typeof d.pid==="string"&&d.pid?0:1)' && ok "GET /api/version → {api:1, pid:<ver>}" || bad "version payload wrong: $VER"
curl -fs "http://127.0.0.1:$PORT/api/services" 2>/dev/null | node -e 'const a=JSON.parse(require("fs").readFileSync(0,"utf8"));process.exit(Array.isArray(a)&&a.some(s=>s.name==="bud")?0:1)' && ok "GET /api/services → real list (incl. bud)" || bad "services list missing bud"
curl -fs "http://127.0.0.1:$PORT/api/budget/bud" 2>/dev/null | node -e 'const d=JSON.parse(require("fs").readFileSync(0,"utf8"));process.exit(d.paused===true&&(d.snapshot?.tokensDay|0)>=50?0:1)' && ok "GET /api/budget/bud → real paused BudgetView" || bad "budget view not paused"

# ── Live SSE stream carried the real run ──
sse() { node "$DIR/sse-check.mjs" "$SSE" "$1"; }
sse snapshot     && ok "SSE: snapshot frame carries services[]"        || bad "SSE: no snapshot"
sse pi           && ok "SSE: log frame carries a real pi event"        || bad "SSE: no pi log frame"
sse budget_pause && ok "SSE: log frame carries pid_budget_pause"       || bad "SSE: no pid_budget_pause frame"
sse service_exit && ok "SSE: log frame carries pid_service_exit"       || bad "SSE: no pid_service_exit frame"

# ── POST action mutates the real daemon ──
curl -fs -X POST "http://127.0.0.1:$PORT/api/budget/bud/reset" 2>/dev/null | node -e 'const d=JSON.parse(require("fs").readFileSync(0,"utf8"));process.exit(d.ok===true?0:1)' && ok "POST /api/budget/bud/reset → ok:true" || bad "reset action failed"
curl -fs "http://127.0.0.1:$PORT/api/budget/bud" 2>/dev/null | node -e 'const d=JSON.parse(require("fs").readFileSync(0,"utf8"));process.exit((d.snapshot?.tokensDay|0)===0?0:1)' && ok "action took effect (tokensDay → 0)" || bad "reset had no effect"

scn_done
