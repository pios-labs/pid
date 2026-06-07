#!/usr/bin/env bash
# errored-turn — force real pi into a failed LLM turn and capture the agent_end shape.
# This is the crash detector's OTHER trigger (crash.ts deriveSignature "agent:error"), which S1's
# clean turn (stopReason "stop", willRetry false) could not exercise. Forcing function: point the
# service at a nonexistent model id so the provider call errors. We assert STRUCTURE (an errored
# assistant message + willRetry false), then feed the captured event into the REAL compiled
# deriveSignature to prove the consuming code derives "agent:error" from genuine pi bytes.
#
# Expectation written BEFORE the run (the method): a bad model id yields an agent_end whose last
# assistant message has stopReason "error" with an errorMessage, and willRetry false (a model-not-
# found / auth error is non-retryable, or retries are exhausted) — so deriveSignature → "agent:error".
set -euo pipefail
source "$(dirname "${BASH_SOURCE[0]}")/lib.sh"
scn_init errored-turn

cat >"$PID_HOME/services/err.yaml" <<YAML
name: err
cwd: $PID_HOME/work
prompt: "Reply with exactly: PID-VERIFY-ERR and nothing else."
model:
  provider: zai
  id: glm-nonexistent-pid-verify
YAML

start_daemon
pcli start err >/dev/null
wait_for err agent_end 80 || echo "  (warning: no agent_end within timeout — asserting on what arrived)"
capture err

C="$CAP_DIR/errored-turn.jsonl"
assert "agent_end present"                       "$C" "e.some(x=>x.type==='agent_end')"
assert "final agent_end has willRetry===false"   "$C" "(()=>{const a=e.filter(x=>x.type==='agent_end');const g=a[a.length-1];return g&&g.data?.willRetry===false})()"
assert "last assistant stopReason==='error'"     "$C" "(()=>{const a=e.filter(x=>x.type==='agent_end');const g=a[a.length-1];const m=(g?.data?.messages||[]).filter(x=>x.role==='assistant');return m.length>0&&m[m.length-1].stopReason==='error'})()"

# Strongest proof: feed the real captured agent_end DATA (pi's raw event, what the supervisor
# forwards) into the actual compiled crash detector and confirm it derives "agent:error".
SIG="$(node -e '
const fs=require("fs");
const { deriveSignature } = require("'"$REPO"'/dist/governor/crash.js");
const e=fs.readFileSync("'"$C"'","utf8").trim().split("\n").map(JSON.parse);
const a=e.filter(x=>x.type==="agent_end");
const g=a[a.length-1];
console.log(deriveSignature(g?.data));
' 2>/dev/null)"
if [ "$SIG" = "agent:error" ]; then ok "real deriveSignature(agent_end) → agent:error"; else bad "deriveSignature gave: ${SIG:-<none>}"; fi

scn_done
