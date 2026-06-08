#!/usr/bin/env bash
# S4 (CP4) — the approval round-trip through a REAL pi extension.
# Usage: bash s4-approval.sh [confirm|select|input|editor]   (default confirm)
#
# This is the most important checkpoint: it exercises the OTHER host→pi send() path — pid writing
# extension_ui_response back to pi — the sibling of the prompt-delivery gap that started this
# remediation. A real pi extension (verification/extensions/pid-verify-ui.ts, loaded via the
# `extensions:` YAML → `-e`) gates the bash tool behind a UI dialog. Under `pi --mode rpc` that
# becomes a real extension_ui_request; pid's router enqueues it; we run `pid approve`; pid replies
# over stdin; pi accepts the reply and the bash tool proceeds. Fakes are banned here.
#
# Expectation written BEFORE the run (the method): the agent runs bash → the extension raises the
# chosen dialog → a real extension_ui_request{method:<method>} appears → router enqueues
# (pid_approval phase:enqueue) → `pid approve` → pid_approval phase:resolve decision:approve → pi
# accepts {confirmed:true}/{value:"approve"} and the bash tool_execution_end is NOT an error.
#
# If NO approval appears, that is itself a finding (e.g. the A6 trust model silently dropping the
# -e extension in RPC mode) — the diagnostics below surface it rather than failing silently.
set -euo pipefail
source "$(dirname "${BASH_SOURCE[0]}")/lib.sh"

METHOD="${1:-confirm}"
scn_init "s4-approval-$METHOD"

EXT="$REPO/verification/extensions/pid-verify-ui.ts"
[ -f "$EXT" ] || { echo "missing extension: $EXT" >&2; exit 1; }

cat >"$PID_HOME/services/appr.yaml" <<YAML
name: appr
cwd: $PID_HOME/work
prompt: "Run the shell command: echo PID-VERIFY-APPROVAL — use your bash tool to run it. Then reply DONE."
model:
  provider: zai
  id: glm-5.1
extensions:
  - $EXT
# Cautious posture (top-level field, ADR 0004): an unmatched command (echo) ENQUEUES rather than
# auto-approving, so the operator round-trip (pid approve → reply over stdin) is what gets exercised.
on_unmatched: ask
YAML

# The pi child inherits the daemon's env — choose which dialog the extension fires.
export PID_VERIFY_UI="$METHOD"
start_daemon
pcli start appr >/dev/null

# Wait for the dialog to surface as a pending approval (pi blocks on it, so no race).
ID=""
for _ in $(seq 1 160); do
	ID="$(pcli approvals --json 2>/dev/null | node -e 'try{const a=JSON.parse(require("fs").readFileSync(0,"utf8"));process.stdout.write(a[0]?.id??"")}catch{}')"
	[ -n "$ID" ] && break
	sleep 0.5
done

if [ -z "$ID" ]; then
	echo "  ✗ no approval surfaced — diagnostics:" >&2
	echo "  --- chronicle event types ---" >&2
	node -e 'try{require("fs").readFileSync("'"$PID_HOME"'/logs/appr.jsonl","utf8").trim().split("\n").forEach(l=>process.stderr.write("    "+JSON.parse(l).type+"\n"))}catch(e){process.stderr.write("    (no chronicle)\n")}' 2>&1
	echo "  --- daemon.log tail ---" >&2
	tail -15 "$PID_HOME/daemon.log" >&2 2>/dev/null || true
else
	echo "  approval pending: id=${ID:0:8} method=$METHOD"
	if [ "$METHOD" = "confirm" ]; then
		pcli approve "$ID" >/dev/null && echo "  approved (confirm → {confirmed:true})"
	else
		pcli approve "$ID" --value approve >/dev/null && echo "  approved (--value approve → {value:'approve'})"
	fi
fi

wait_for appr agent_end 80 || echo "  (warning: no agent_end within timeout — asserting on what arrived)"
capture appr

C="$CAP_DIR/s4-approval-$METHOD.jsonl"
assert "real extension_ui_request present"           "$C" "e.some(x=>x.type==='extension_ui_request')"
assert "request method is '$METHOD'"                 "$C" "e.some(x=>x.type==='extension_ui_request'&&x.data?.method==='$METHOD')"
# Method-appropriate request shape: confirm carries message; select carries an options array.
if [ "$METHOD" = "select" ]; then
	assert "select request carries options[]"        "$C" "e.some(x=>x.type==='extension_ui_request'&&x.data?.method==='select'&&Array.isArray(x.data?.options))"
else
	assert "confirm request carries message"         "$C" "e.some(x=>x.type==='extension_ui_request'&&x.data?.method==='confirm'&&typeof x.data?.message==='string')"
fi
assert "router enqueued it (pid_approval enqueue)"   "$C" "e.some(x=>x.type==='pid_approval'&&x.data?.phase==='enqueue')"
assert "operator approved it (resolve, by:cli)"      "$C" "e.some(x=>x.type==='pid_approval'&&x.data?.phase==='resolve'&&x.data?.decision==='approve'&&x.data?.by==='cli')"
assert "pi ACCEPTED the reply + CONTINUED: bash ran, not an error" "$C" "e.some(x=>x.type==='tool_execution_end'&&x.data?.toolName==='bash'&&!x.data?.isError)"

scn_done
