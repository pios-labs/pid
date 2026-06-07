#!/usr/bin/env bash
# S2 — real pi makes a successful tool call and a failing one.
# Proves the SHAPES the crash detector + governor consume: tool_execution_start / tool_execution_end,
# the isError flag on a failure, and toolName. Forcing function: a prompt that directly orders two
# read-tool calls, one on a present file, one on a missing path.
set -euo pipefail
source "$(dirname "${BASH_SOURCE[0]}")/lib.sh"
scn_init s2-tool-call

echo "hello from pid verification" >"$PID_HOME/work/notes.txt"

cat >"$PID_HOME/services/s2.yaml" <<YAML
name: s2
cwd: $PID_HOME/work
prompt: "Do exactly this, using your file-reading tool for each step: (1) read the file notes.txt in the current directory; (2) read the file /nonexistent-pid-xyz.txt. Then reply DONE."
model:
  provider: zai
  id: glm-5.1
YAML

start_daemon
pcli start s2 >/dev/null
wait_for s2 agent_end 80 || echo "  (warning: no agent_end within timeout — asserting on what arrived)"
capture s2

C="$CAP_DIR/s2-tool-call.jsonl"
assert "tool_execution_start present"        "$C" "e.some(x=>x.type==='tool_execution_start')"
assert "tool_execution_end present"          "$C" "e.some(x=>x.type==='tool_execution_end')"
assert "a failing tool (isError truthy)"     "$C" "e.some(x=>x.type==='tool_execution_end'&&x.data?.isError)"
assert "tool_execution_end carries toolName" "$C" "e.some(x=>x.type==='tool_execution_end'&&typeof x.data?.toolName==='string')"

scn_done
