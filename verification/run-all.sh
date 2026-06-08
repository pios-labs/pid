#!/usr/bin/env bash
# Gated real-pi regression — runs every verification scenario against the REAL pi binary, re-proving
# the LEDGER rows in one command. This is `npm run test:real`.
#
# SELF-SKIPS (exit 0) when there is no pi binary or no pi auth, so a fresh clone / CI never fails on
# it — the empirical suite is opt-in by virtue of the environment, exactly like the discipline says.
# Per-provider gating: the zai/$0 scenarios run when zai auth is present; the paid dollar scenario
# (s9, anthropic) runs only when anthropic auth is present, else it is skipped (not failed).
#
# Spend: s1–s8 + errored-turn + s7 use the $0 zai subscription (real tokens, no dollars); s9 uses a
# paid anthropic turn (~$0.002). Re-run any single scenario directly: bash verification/scenarios/<id>.sh
set -uo pipefail
DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/scenarios"
REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
AUTH="${PI_AUTH_FILE:-$HOME/.pi/agent/auth.json}"

if ! command -v pi >/dev/null 2>&1; then echo "test:real SKIPPED — no pi binary on PATH"; exit 0; fi
if [ ! -f "$AUTH" ]; then echo "test:real SKIPPED — pi not authenticated ($AUTH absent)"; exit 0; fi
have() { grep -q "\"$1\"" "$AUTH" 2>/dev/null; }

echo "── pid real-pi regression ──  pi $(pi --version 2>&1)  ·  ref-clone $(git -C "$REPO/../pi" rev-parse --short HEAD 2>/dev/null)"
( cd "$REPO" && npm run build >/dev/null 2>&1 ) || { echo "build failed — aborting"; exit 1; }

PASS=0; FAIL=0; SKIP=0; FAILED=""
run() { # run <label> <script.sh> [args...]
	local label="$1"; shift
	echo; echo "▶ $label"
	if bash "$@"; then PASS=$((PASS + 1)); else FAIL=$((FAIL + 1)); FAILED="$FAILED\n  - $label"; fi
}
skip() { echo; echo "▶ $1 — SKIPPED ($2)"; SKIP=$((SKIP + 1)); }

if have zai; then
	run "s1 basic turn"        "$DIR/s1-basic-turn.sh"
	run "s2 tool call"         "$DIR/s2-tool-call.sh"
	run "errored turn"         "$DIR/errored-turn.sh"
	run "s3 crash quarantine"  "$DIR/s3-crash-quarantine.sh"
	run "s5 budget (tokens)"   "$DIR/s5-budget-pause.sh"
	run "s4 approval confirm"  "$DIR/s4-approval.sh" confirm
	run "s4 approval select"   "$DIR/s4-approval.sh" select
	run "s6 stop / shutdown"   "$DIR/s6-stop-shutdown.sh"
	run "s7 reload"            "$DIR/s7-reload.sh"
	run "s8 dashboard"         "$DIR/s8-dashboard.sh"
else
	skip "zai scenarios (s1–s8, errored-turn)" "no zai auth"
fi

if have anthropic; then
	run "s9 dollars (anthropic, ~\$0.002)" "$DIR/s9-dollars.sh"
else
	skip "s9 dollars" "no anthropic auth"
fi

echo
echo "════ real-pi regression: $PASS passed, $FAIL failed, $SKIP skipped ════"
[ "$FAIL" -eq 0 ] || { echo -e "failed:$FAILED"; exit 1; }
