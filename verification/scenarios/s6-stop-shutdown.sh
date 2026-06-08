#!/usr/bin/env bash
# S6 (CP5) — stop / shutdown flush on real pi.
# Two parts:
#   A. pi's teardown EXIT-CODE CONTRACT (the premise behind pid's stdin-close choice, ADR 0001):
#      stdin-close → exit 0 (pi flushes), SIGTERM → exit 143 (pi SKIPS the flush). The exit codes are
#      the observable proxy for pi's `if (signal !== "SIGTERM") flushRawStdout()` gate
#      (rpc-mode.ts:694). Probed directly against the real binary, no daemon, $0 spend.
#   B. through pid: a real running service → `pid stop` → reaches "stopped" with the FULL chronicle
#      intact (agent_end present, last line is complete JSON — no truncation) and NO synthetic
#      pid_service_exit (a clean stop's graceful pi shutdown needs none; ADR 0012).
#
# Expectation written BEFORE the run: A → {code:0} and {code:143}; B → state "stopped", agent_end
# captured, last chronicle line parses, no pid_service_exit.
set -euo pipefail
source "$(dirname "${BASH_SOURCE[0]}")/lib.sh"
scn_init s6-stop-shutdown

# ── Part A: pi's exit-code contract (direct, no daemon) ──
A_STDIN="$(node "$(dirname "${BASH_SOURCE[0]}")/pi-exit-probe.mjs" stdin)"
echo "  stdin-close → $A_STDIN"
echo "$A_STDIN"  | node -e 'const d=JSON.parse(require("fs").readFileSync(0,"utf8"));process.exit(d.code===0?0:1)'   && ok "stdin-close → exit 0 (pi flushed)"     || bad "stdin-close did not exit 0 (got $A_STDIN)"
A_TERM="$(node "$(dirname "${BASH_SOURCE[0]}")/pi-exit-probe.mjs" sigterm)"
echo "  SIGTERM → $A_TERM"
echo "$A_TERM"   | node -e 'const d=JSON.parse(require("fs").readFileSync(0,"utf8"));process.exit(d.code===143?0:1)' && ok "SIGTERM → exit 143 (flush skipped, handler ran)" || bad "SIGTERM did not exit 143 (got $A_TERM)"

# ── Part B: graceful stop through pid ──
cat >"$PID_HOME/services/life.yaml" <<YAML
name: life
cwd: $PID_HOME/work
prompt: "Reply with exactly: PID-VERIFY-S6 and nothing else."
model:
  provider: zai
  id: glm-5.1
YAML

start_daemon
pcli start life >/dev/null
wait_for life agent_end 80 || echo "  (warning: no agent_end before stop)"
pcli stop life >/dev/null
# give finalizeExit a moment to record the terminal state
for _ in $(seq 1 40); do [ "$(pcli status life --json 2>/dev/null | node -e 'try{process.stdout.write(JSON.parse(require("fs").readFileSync(0,"utf8")).state)}catch{}')" = "stopped" ] && break; sleep 0.25; done
capture life

C="$CAP_DIR/s6-stop-shutdown.jsonl"
ST="$(pcli status life --json 2>/dev/null | node -e 'try{process.stdout.write(JSON.parse(require("fs").readFileSync(0,"utf8")).state)}catch{}')"
[ "$ST" = "stopped" ] && ok "pid stop → state stopped" || bad "expected stopped, got '$ST'"
assert "full turn survived shutdown (agent_end captured)" "$C" "e.some(x=>x.type==='agent_end')"
assert "no pid_service_exit on a clean stop"              "$C" "!e.some(x=>x.type==='pid_service_exit')"
# No truncation: the last non-empty chronicle line must be complete JSON.
tail -c 100000 "$C" | node -e 'const ls=require("fs").readFileSync(0,"utf8").trim().split("\n").filter(Boolean);try{JSON.parse(ls[ls.length-1]);process.exit(0)}catch{process.exit(1)}' && ok "chronicle not truncated (last line parses)" || bad "last chronicle line is truncated"

scn_done
