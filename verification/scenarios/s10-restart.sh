#!/usr/bin/env bash
# S10 (ADR 0013) — the restart relauncher re-spawns a CRASHED real pi, and a crash loop quarantines.
# Forcing function: externally `kill -9` the live pi child (an unexpected death pid did NOT initiate).
# Under restart.policy=always the relauncher re-spawns it (new pid, fresh agent_start). Repeating the
# kill drives proc:signal_SIGKILL into the crash detector; at the threshold (3) it quarantines —
# terminal, the "240 identical failures → pull the plug" hero scenario, now real for process exits.
#
# Expectation written BEFORE the run: kill #1 → a NEW pid appears (relaunched), with pid_service_exit
# {proc:signal_SIGKILL} + pid_restart{scheduled} in the chronicle; after 3 kills the service is
# quarantined with a pid_quarantine{signature:proc:signal_SIGKILL, by:crash_detector}. The
# policy/backoff/max_consecutive matrix itself is pure logic, unit-tested in test/restart.test.ts.
set -euo pipefail
source "$(dirname "${BASH_SOURCE[0]}")/lib.sh"
scn_init s10-restart

statusf() { pcli status "$1" --json 2>/dev/null | node -e "try{const d=JSON.parse(require('fs').readFileSync(0,'utf8'));const v=d['$2'];process.stdout.write(v==null?'':String(v))}catch{}"; }

# Wait until the service is running on a pid different from $2 (a completed relaunch). Echoes the new
# pid, or returns 1 if it quarantines / times out first.
wait_relaunch() { # wait_relaunch <svc> <old-pid> [max-tenths]
	local svc="$1" old="$2" max="${3:-200}"
	for _ in $(seq 1 "$max"); do
		local p s
		p="$(statusf "$svc" pid)"
		s="$(statusf "$svc" state)"
		[ "$s" = "quarantined" ] && return 1
		if [ -n "$p" ] && [ "$p" != "$old" ] && [ "$s" = "running" ]; then
			echo "$p"
			return 0
		fi
		sleep 0.5
	done
	return 1
}

cat >"$PID_HOME/services/relaunch.yaml" <<YAML
name: relaunch
cwd: $PID_HOME/work
prompt: "Reply with exactly: PID-VERIFY-S10 and nothing else."
model:
  provider: zai
  id: glm-5.1
restart:
  policy: always
  backoff:
    initial_ms: 500
    max_ms: 1500
    factor: 1
quarantine:
  same_failure_threshold: 3
  window_seconds: 300
YAML

start_daemon
pcli start relaunch >/dev/null
wait_for relaunch agent_end 80 || echo "  (warning: no first agent_end)"
PID1="$(statusf relaunch pid)"
echo "  initial pid=$PID1"

# Kill #1 — external SIGKILL of the live pi; the relauncher should bring it back under policy:always.
kill -9 "$PID1" 2>/dev/null || true
PID2="$(wait_relaunch relaunch "$PID1" || true)"
if [ -n "$PID2" ] && [ "$PID2" != "$PID1" ]; then ok "relaunched after external kill (pid $PID1 → $PID2)"; else bad "service was NOT relaunched after kill (got '$PID2')"; fi

# Kill #2 then #3 — drive the same signature past the quarantine threshold.
[ -n "$PID2" ] && kill -9 "$PID2" 2>/dev/null || true
PID3="$(wait_relaunch relaunch "${PID2:-$PID1}" || true)"
[ -n "$PID3" ] && echo "  relaunched again pid=$PID3" && kill -9 "$PID3" 2>/dev/null || true

# After the 3rd identical failure the crash detector should quarantine (terminal).
for _ in $(seq 1 120); do [ "$(statusf relaunch state)" = "quarantined" ] && break; sleep 0.5; done
capture relaunch

C="$CAP_DIR/s10-restart.jsonl"
ST="$(statusf relaunch state)"
[ "$ST" = "quarantined" ] && ok "crash loop quarantined the service (terminal)" || bad "expected quarantined, got '$ST'"
# Three external kills, each named a SIGKILL failure (not mistaken for a deliberate stop).
assert "3 external SIGKILLs logged as failures"        "$C" "e.filter(x=>x.type==='pid_service_exit'&&x.data?.signature==='proc:signal_SIGKILL').length>=3"
# Two relaunches actually scheduled+fired by the relauncher (the live pid changing each time, asserted
# above, proves they reached running — the relaunched pi's were then killed fast, before agent_start).
assert "relauncher re-spawned it twice (attempts 1,2)" "$C" "e.filter(x=>x.type==='pid_restart'&&x.data?.phase==='scheduled'&&x.data?.by==='relauncher').length>=2"
assert "pid_quarantine on the proc:signal_SIGKILL loop" "$C" "e.some(x=>x.type==='pid_quarantine'&&x.data?.signature==='proc:signal_SIGKILL'&&x.data?.count===3&&x.data?.by==='crash_detector')"

scn_done
