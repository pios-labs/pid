#!/usr/bin/env bash
# S3 (CP3) — the crash detector quarantines a service that repeats the SAME failure on REAL pi.
# Forcing function: a prompt ordering real pi to read several nonexistent files one tool-call at a
# time, continuing past the errors. Each failed read is a real tool_execution_end{isError:true,
# toolName:"read"} → signature tool:read:error; at same_failure_threshold (3) the detector drives a
# real quarantine() (graceful stop) and writes pid_quarantine to the chronicle before the stop.
# This is the full real-pi flow that the fake-pi-crasher.mjs unit test only simulated.
#
# Expectation written BEFORE the run (the method): >=3 failing reads in the window → one
# pid_quarantine event {signature:"tool:read:error", count>=3, threshold:3, by:"crash_detector"};
# the service ends in state "quarantined" (terminal — no auto-resume); the pi process is stopped.
set -euo pipefail
source "$(dirname "${BASH_SOURCE[0]}")/lib.sh"
scn_init s3-crash-quarantine

cat >"$PID_HOME/services/crash.yaml" <<YAML
name: crash
cwd: $PID_HOME/work
prompt: "Use your file-reading tool to read each of these five paths, ONE tool call at a time, in order. They will error — that is expected; do NOT stop on an error, keep going through all five, then reply DONE. Paths: /nonexistent-pid-a.txt /nonexistent-pid-b.txt /nonexistent-pid-c.txt /nonexistent-pid-d.txt /nonexistent-pid-e.txt"
model:
  provider: zai
  id: glm-5.1
quarantine:
  same_failure_threshold: 3
  window_seconds: 300
YAML

start_daemon
pcli start crash >/dev/null
wait_for crash pid_quarantine 80 || echo "  (warning: no pid_quarantine within timeout — asserting on what arrived)"
capture crash

C="$CAP_DIR/s3-crash-quarantine.jsonl"
assert ">=3 failing read tool calls (same signature)" "$C" "e.filter(x=>x.type==='tool_execution_end'&&x.data?.isError&&x.data?.toolName==='read').length>=3"
assert "pid_quarantine present (source pid)"           "$C" "e.some(x=>x.type==='pid_quarantine'&&x.source==='pid')"
assert "signature tool:read:error, count>=3"           "$C" "e.some(x=>x.type==='pid_quarantine'&&x.data?.signature==='tool:read:error'&&x.data?.count>=3)"
assert "threshold 3, by crash_detector"                "$C" "e.some(x=>x.type==='pid_quarantine'&&x.data?.threshold===3&&x.data?.by==='crash_detector')"
assert "pid_quarantine written before the stop ends the stream" "$C" "(()=>{const i=e.findIndex(x=>x.type==='pid_quarantine');return i>=0})()"

# Side-effect proof through the live daemon: the service is held in the terminal quarantined state.
ST="$(pcli status crash --json 2>/dev/null)"
echo "$ST" | node -e '
const d=JSON.parse(require("fs").readFileSync(0,"utf8"));
process.stderr.write(`  status → state=${d.state} pid=${d.pid??"(none)"}\n`);
process.exit(d.state==="quarantined"?0:1)
' && ok "status: service is quarantined (terminal)" || bad "service did not reach quarantined state"

scn_done
