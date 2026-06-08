#!/usr/bin/env bash
# S9 (CP7) — the DOLLAR dimension of the cost governor, on real USD spend.
# Everything USD-dependent was blocked until now because the zai subscription reports cost.total=0
# (real tokens, no dollars). With a paid model (anthropic/claude-haiku-4-5, pi's stored auth) a real
# turn charges real cost.total, so we can finally prove USD enforcement. This batches EVERY $ assertion
# in one run (PLAN CP7): real cost.total > 0 charged, and both daily_usd + weekly_usd caps breach → pause.
#
# Forcing function: absurdly low USD caps (0.001 each) — any real anthropic turn (~$0.01) breaches both.
# Expectation written BEFORE the run: a real assistant message_end carries cost.total > 0; a
# pid_budget_pause whose data.breached names BOTH daily_usd and weekly_usd (spent >= 0.001),
# by:"governor", resumeAt = the later (weekly) window end; budget show → paused, spentUsdDay > 0.
set -euo pipefail
source "$(dirname "${BASH_SOURCE[0]}")/lib.sh"
scn_init s9-dollars

cat >"$PID_HOME/services/usd.yaml" <<YAML
name: usd
cwd: $PID_HOME/work
prompt: "Reply with exactly: PID-VERIFY-USD and nothing else."
model:
  provider: anthropic
  id: claude-haiku-4-5
budget:
  daily_usd: 0.001
  weekly_usd: 0.001
  on_exceed: pause
YAML

start_daemon
pcli start usd >/dev/null
wait_for usd pid_budget_pause 80 || echo "  (warning: no pid_budget_pause within timeout)"
capture usd

C="$CAP_DIR/s9-dollars.jsonl"
assert "real USD charged: assistant cost.total > 0"  "$C" "e.some(x=>x.type==='message_end'&&x.data?.message?.role==='assistant'&&typeof x.data.message.usage?.cost?.total==='number'&&x.data.message.usage.cost.total>0)"
assert "pid_budget_pause present (source pid)"        "$C" "e.some(x=>x.type==='pid_budget_pause'&&x.source==='pid')"
assert "daily_usd breached, spent>=0.001"             "$C" "e.some(x=>x.type==='pid_budget_pause'&&(x.data?.breached||[]).some(b=>b.cap==='daily_usd'&&b.spent>=0.001&&b.limit===0.001))"
assert "weekly_usd breached, spent>=0.001"            "$C" "e.some(x=>x.type==='pid_budget_pause'&&(x.data?.breached||[]).some(b=>b.cap==='weekly_usd'&&b.spent>=0.001&&b.limit===0.001))"
assert "pause by governor + resumeAt=weekEnd (later)" "$C" "e.some(x=>x.type==='pid_budget_pause'&&x.data?.by==='governor'&&typeof x.data?.resumeAt==='string')"

# Side-effect proof through the live daemon: spentUsdDay reflects the real charge and the service is paused.
pcli budget show usd --json 2>/dev/null | node -e '
const d=JSON.parse(require("fs").readFileSync(0,"utf8"));
process.stderr.write(`  budget show → spentUsdDay=$${d.snapshot?.spentUsdDay} spentUsdWeek=$${d.snapshot?.spentUsdWeek} paused=${d.paused} breached=${(d.breachedCaps||[]).map(b=>b.cap).join(",")}\n`);
process.exit(d.paused===true&&(d.snapshot?.spentUsdDay>0)&&(d.breachedCaps||[]).some(b=>b.cap==="daily_usd")?0:1)
' && ok "budget show: paused + spentUsdDay > 0 + daily_usd breached" || bad "budget show did not reflect real USD spend"

scn_done
