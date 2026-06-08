#!/usr/bin/env bash
# S7 (CP5) — `pid reload` reconciles against a REAL running pi process (ADR 0010).
# The governing rule, from pi's own /reload: NEVER interrupt running work. A running service keeps
# the definition it started with; a changed definition is staged and adopted on its next start.
#
# Covers four real-process dispositions in one run:
#   - added            : a new YAML file (not running)          → registered
#   - modified-running : edit a running service's file          → STAGED (pendingConfig), process UNTOUCHED
#   - adoption         : restart the staged service             → new definition takes effect
#   - orphaned         : remove a running service's file        → left running, flagged, deregistered next stop
#
# Expectation written BEFORE the run: reload#1 summary {added:[fresh], staged:[keep]}; keep's PID is
# unchanged across reload#1 (not restarted); a pid_config_changed event in keep's chronicle;
# status keep configChanged:true. After a restart the chronicle shows the NEW prompt marker and
# configChanged clears. reload#2 (file removed) → {orphaned:[keep]}, keep still running, orphaned:true.
set -euo pipefail
source "$(dirname "${BASH_SOURCE[0]}")/lib.sh"
scn_init s7-reload

writekeep() { # writekeep <marker>
	cat >"$PID_HOME/services/keep.yaml" <<YAML
name: keep
cwd: $PID_HOME/work
prompt: "Reply with exactly: $1 and nothing else."
model:
  provider: zai
  id: glm-5.1
YAML
}

statusf() { pcli status "$1" --json 2>/dev/null | node -e "try{const d=JSON.parse(require('fs').readFileSync(0,'utf8'));process.stdout.write(String(d['$2']))}catch{}"; }

writekeep PID-VERIFY-S7-A
start_daemon
pcli start keep >/dev/null
wait_for keep agent_end 80 || echo "  (warning: keep produced no agent_end)"
PID_BEFORE="$(statusf keep pid)"

# Disposition setup: add a brand-new (unstarted) service, and modify the running one.
cat >"$PID_HOME/services/fresh.yaml" <<YAML
name: fresh
cwd: $PID_HOME/work
prompt: "noop"
YAML
writekeep PID-VERIFY-S7-B   # modify keep while it runs

R1="$(pcli reload --json 2>/dev/null)"
echo "  reload#1 → $R1"
echo "$R1" | node -e 'const d=JSON.parse(require("fs").readFileSync(0,"utf8"));process.exit((d.added||[]).includes("fresh")&&(d.staged||[]).includes("keep")?0:1)' && ok "reload#1: added=[fresh], staged=[keep]" || bad "reload#1 dispositions wrong"
PID_AFTER="$(statusf keep pid)"
[ -n "$PID_BEFORE" ] && [ "$PID_BEFORE" = "$PID_AFTER" ] && ok "running work NOT interrupted (pid $PID_BEFORE unchanged)" || bad "keep was restarted by reload (pid $PID_BEFORE → $PID_AFTER)"
[ "$(statusf keep state)" = "running" ] && ok "keep still running after reload" || bad "keep not running after reload"
[ "$(statusf keep configChanged)" = "true" ] && ok "status: configChanged flagged" || bad "configChanged not set"

# pid_config_changed must be in keep's chronicle (transition event).
capture keep
C="$CAP_DIR/s7-reload.jsonl"
assert "pid_config_changed event written (by reload)" "$C" "e.some(x=>x.type==='pid_config_changed'&&x.data?.by==='reload'&&x.data?.change==='modified')"

# Adoption: restart keep → the staged (prompt B) definition takes effect.
pcli stop keep >/dev/null
for _ in $(seq 1 40); do [ "$(statusf keep state)" = "stopped" ] && break; sleep 0.25; done
pcli start keep >/dev/null
wait_for keep agent_end 80 || true
# wait for the SECOND agent_end / the B marker to land
for _ in $(seq 1 40); do grep -q "PID-VERIFY-S7-B" "$PID_HOME/logs/keep.jsonl" 2>/dev/null && break; sleep 0.5; done
capture keep
grep -q "PID-VERIFY-S7-B" "$C" && ok "staged definition ADOPTED on restart (prompt B in chronicle)" || bad "new prompt not adopted"
[ "$(statusf keep configChanged)" = "false" ] && ok "configChanged cleared after adoption" || bad "configChanged still set after restart"

# Orphan: remove the running service's file, reload → left running, flagged orphaned.
rm -f "$PID_HOME/services/keep.yaml"
R2="$(pcli reload --json 2>/dev/null)"
echo "  reload#2 → $R2"
echo "$R2" | node -e 'const d=JSON.parse(require("fs").readFileSync(0,"utf8"));process.exit((d.orphaned||[]).includes("keep")?0:1)' && ok "reload#2: orphaned=[keep]" || bad "keep not orphaned"
[ "$(statusf keep state)" = "running" ] && ok "orphaned service left running (not killed)" || bad "orphan was killed"
[ "$(statusf keep orphaned)" = "true" ] && ok "status: orphaned flagged" || bad "orphaned not set"

scn_done
