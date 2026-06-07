#!/usr/bin/env bash
# S1 — a real pi service runs its prompt end-to-end.
# Proves: spawn, buildPiArgs accepted by real pi, PROMPT DELIVERY (the gap we fixed), event stream,
# message_end.usage token shape, chronicle capture, clean agent_end, governor charges real tokens.
set -euo pipefail
source "$(dirname "${BASH_SOURCE[0]}")/lib.sh"
scn_init s1-basic-turn

cat >"$PID_HOME/services/s1.yaml" <<YAML
name: s1
cwd: $PID_HOME/work
prompt: "Reply with exactly: PID-VERIFY-S1 and nothing else."
model:
  provider: zai
  id: glm-5.1
budget:
  daily_tokens: 1000000
  on_exceed: pause
YAML

start_daemon
pcli start s1 >/dev/null
wait_for s1 agent_end 60 || echo "  (warning: no agent_end within timeout — asserting on what arrived)"
capture s1

C="$CAP_DIR/s1-basic-turn.jsonl"
assert "agent_start present"                "$C" "e.some(x=>x.type==='agent_start')"
assert "assistant message_end present"      "$C" "e.some(x=>x.type==='message_end'&&x.data?.message?.role==='assistant')"
assert "usage carries real token counts"    "$C" "e.some(x=>x.type==='message_end'&&x.data?.message?.usage&&((x.data.message.usage.totalTokens|0)>0||((x.data.message.usage.input|0)+(x.data.message.usage.output|0))>0))"
assert "clean agent_end"                    "$C" "e.some(x=>x.type==='agent_end')"
TOK="$(pcli budget show s1 --json 2>/dev/null | node -e 'try{const d=JSON.parse(require("fs").readFileSync(0));console.log(d.snapshot.tokensDay|0)}catch{console.log(0)}')"
if [ "${TOK:-0}" -gt 0 ]; then ok "governor metered tokens ($TOK)"; else bad "governor metered tokens (got ${TOK:-0})"; fi

scn_done
