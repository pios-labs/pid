#!/usr/bin/env bash
# S5 (CP2) — the cost governor enforces a token cap on REAL pi spend.
# Forcing function: a real service with an absurdly low daily_tokens cap (50). One real pi turn
# spends ~hundreds-to-thousands of tokens (the four-component sum is the whole context regardless of
# cache split), so the very first assistant message_end breaches the cap. We prove the WHOLE real
# path: real usage → extractUsage → BudgetStore → evaluateBreach → pause() → pid_budget_pause written
# to the chronicle (before the stop, while the stream is open) → the service is held paused → and
# `pid budget reset` zeroes the window accounting.
#
# Expectation written BEFORE the run (the method): real spend crosses 50 tokens on turn 1 → a
# pid_budget_pause event whose data.breached names daily_tokens (spent >= 50), by:"governor", with a
# resumeAt; `pid budget show` reports paused:true + breachedCaps daily_tokens; `pid budget reset`
# returns tokensDay 0.
#
# Out of scope here (pure logic, already unit-tested with an injected clock in governor.test.ts, and
# untouchable from a black-box live daemon): the auto-resume TIMER firing at the next window rollover.
# CP2 verifies the real-pi integration boundary; the rollover math never touches pi's runtime.
set -euo pipefail
source "$(dirname "${BASH_SOURCE[0]}")/lib.sh"
scn_init s5-budget-pause

cat >"$PID_HOME/services/bud.yaml" <<YAML
name: bud
cwd: $PID_HOME/work
prompt: "Reply with exactly: PID-VERIFY-BUDGET and nothing else."
model:
  provider: zai
  id: glm-5.1
budget:
  daily_tokens: 50
  on_exceed: pause
YAML

start_daemon
pcli start bud >/dev/null
wait_for bud pid_budget_pause 80 || echo "  (warning: no pid_budget_pause within timeout — asserting on what arrived)"
capture bud

C="$CAP_DIR/s5-budget-pause.jsonl"
assert "real assistant spend recorded"           "$C" "e.some(x=>x.type==='message_end'&&x.data?.message?.role==='assistant'&&x.data.message.usage)"
assert "pid_budget_pause present (source pid)"    "$C" "e.some(x=>x.type==='pid_budget_pause'&&x.source==='pid')"
assert "breach names daily_tokens, spent>=50"     "$C" "e.some(x=>x.type==='pid_budget_pause'&&(x.data?.breached||[]).some(b=>b.cap==='daily_tokens'&&b.spent>=50&&b.limit===50))"
assert "pause attributed to governor + resumeAt"  "$C" "e.some(x=>x.type==='pid_budget_pause'&&x.data?.by==='governor'&&typeof x.data?.resumeAt==='string')"

# Side-effect proof through the live daemon: the service is held paused and budget show agrees.
BUD="$(pcli budget show bud --json 2>/dev/null)"
echo "$BUD" | node -e '
const d=JSON.parse(require("fs").readFileSync(0,"utf8"));
const okPaused = d.paused===true;
const okTok = (d.snapshot?.tokensDay|0) >= 50;
const okBreach = (d.breachedCaps||[]).some(b=>b.cap==="daily_tokens");
process.stderr.write(`  budget show → tokensDay=${d.snapshot?.tokensDay} paused=${d.paused} breached=${(d.breachedCaps||[]).map(b=>b.cap).join(",")}\n`);
process.exit(okPaused&&okTok&&okBreach?0:1)
' && ok "budget show: paused + tokensDay>=50 + daily_tokens breached" || bad "budget show did not reflect the pause"

# Reset path (real daemon, accounting-only): zero the window. budget reset does NOT resume (that is
# `pid resume --reset`); it returns the fresh view with tokensDay back to 0.
RST="$(pcli budget reset bud --json 2>/dev/null)"
echo "$RST" | node -e '
const d=JSON.parse(require("fs").readFileSync(0,"utf8"));
process.stderr.write(`  after reset → tokensDay=${d.snapshot?.tokensDay}\n`);
process.exit((d.snapshot?.tokensDay|0)===0?0:1)
' && ok "budget reset zeroed tokensDay" || bad "budget reset did not zero the window"

scn_done
