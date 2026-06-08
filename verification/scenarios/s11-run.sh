#!/usr/bin/env bash
# S11 (ADR 0014) — `pid run` runs a service once as a supervised job and AUTO-STOPS after the turn.
# This is the cron replacement (`0 9 * * * pid run <svc>`): pid supervises, the OS schedules. The job
# must start, deliver its prompt, run a real turn, then stop itself — not linger as an idle session.
#
# Expectation written BEFORE the run: `pid run job` blocks until the turn completes, prints
# "✓ ran job → completed", exits 0; the chronicle shows a real agent_end; and afterwards the service
# is `stopped` (auto-stopped), with no live pid — proving the one-shot lifecycle.
set -euo pipefail
source "$(dirname "${BASH_SOURCE[0]}")/lib.sh"
scn_init s11-run

statusf() { pcli status "$1" --json 2>/dev/null | node -e "try{const d=JSON.parse(require('fs').readFileSync(0,'utf8'));const v=d['$2'];process.stdout.write(v==null?'':String(v))}catch{}"; }

cat >"$PID_HOME/services/job.yaml" <<YAML
name: job
cwd: $PID_HOME/work
prompt: "Reply with exactly: PID-VERIFY-S11 and nothing else."
model:
  provider: zai
  id: glm-5.1
YAML

start_daemon

# pid run blocks until the job finishes; capture its output + real exit code.
RUN_OUT="$PID_HOME/run.out"
if pcli run job >"$RUN_OUT" 2>&1; then RUN_RC=0; else RUN_RC=$?; fi
echo "  run exit=$RUN_RC  output: $(cat "$RUN_OUT")"
capture job

C="$CAP_DIR/s11-run.jsonl"
[ "$RUN_RC" = "0" ] && ok "pid run exited 0 (job completed cleanly)" || bad "pid run exit was $RUN_RC"
grep -q "completed" "$RUN_OUT" && ok "receipt says completed" || bad "no 'completed' receipt (got: $(cat "$RUN_OUT"))"
assert "the job actually ran a real turn (agent_end)" "$C" "e.some(x=>x.type==='agent_end')"

# The decisive one-shot proof: after the blocking run returns, the service has AUTO-STOPPED.
ST="$(statusf job state)"
PIDV="$(statusf job pid)"
[ "$ST" = "stopped" ] && ok "auto-stopped after the turn (state=stopped)" || bad "expected stopped, got '$ST'"
[ -z "$PIDV" ] && ok "no lingering pi process (pid cleared)" || bad "process still alive (pid=$PIDV)"

scn_done
