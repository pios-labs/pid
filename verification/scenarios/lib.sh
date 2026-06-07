# Shared harness for real-pi receipt scenarios (sourced, not run directly).
#
# Ground truth = the real `pi` binary installed on this machine. Each scenario spins up an isolated
# daemon, drives a real service, copies the chronicle it produced to verification/captures/, and runs
# STRUCTURAL assertions (event types / field shapes / side-effects — never model prose, which is
# non-deterministic). Every capture records the pi version + reference-clone head it was taken against.

REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
CAP_DIR="$REPO/verification/captures"

scn_init() { # scn_init <name>
	SCN="$1"
	[ -f "$REPO/dist/cli.js" ] || {
		echo "dist not built — run: npm run build" >&2
		exit 1
	}
	mkdir -p "$CAP_DIR"
	PID_HOME="$(mktemp -d /tmp/pid-verify-XXXXXX)"
	export PID_HOME
	mkdir -p "$PID_HOME/services" "$PID_HOME/work"
	PASS=0
	FAIL=0
	DAEMON_PID=""
	trap scn_teardown EXIT
	echo "── $SCN ──  pi $(pi --version 2>&1)  ·  ref-clone $(git -C "$REPO/../pi" rev-parse --short HEAD 2>/dev/null)"
}

scn_teardown() {
	[ -n "${DAEMON_PID:-}" ] && kill "$DAEMON_PID" 2>/dev/null
	[ -n "${PID_HOME:-}" ] && rm -rf "$PID_HOME" 2>/dev/null
	return 0
}

pcli() { node "$REPO/dist/cli.js" "$@"; }

start_daemon() {
	node "$REPO/dist/daemon.js" >"$PID_HOME/daemon.log" 2>&1 &
	DAEMON_PID=$!
	for _ in $(seq 1 50); do
		pcli list >/dev/null 2>&1 && return 0
		sleep 0.1
	done
	echo "daemon never became ready" >&2
	cat "$PID_HOME/daemon.log" >&2
	exit 1
}

# wait_for <service> <event-type> [timeout-tenths] — poll the live chronicle for an event type.
wait_for() {
	local svc="$1" type="$2" max="${3:-60}"
	for _ in $(seq 1 "$max"); do
		grep -q "\"type\":\"$type\"" "$PID_HOME/logs/$svc.jsonl" 2>/dev/null && return 0
		sleep 0.5
	done
	return 1
}

# capture <service> — copy the chronicle to a committed receipt + record the version meta.
capture() {
	local svc="$1"
	cp "$PID_HOME/logs/$svc.jsonl" "$CAP_DIR/$SCN.jsonl"
	{
		echo "scenario:      $SCN"
		echo "pi:            $(pi --version 2>&1)"
		echo "ref-clone:     $(git -C "$REPO/../pi" rev-parse --short HEAD 2>/dev/null)"
		echo "source:        real pi run (not a fixture)"
	} >"$CAP_DIR/$SCN.meta"
	echo "  capture → verification/captures/$SCN.jsonl"
}

ok() {
	echo "  ✓ $1"
	PASS=$((PASS + 1))
}
bad() {
	echo "  ✗ $1"
	FAIL=$((FAIL + 1))
}

# assert <desc> <capture> <js-expr over `e` (array of envelopes)>
assert() {
	local desc="$1" file="$2" expr="$3"
	if node -e "const e=require('fs').readFileSync('$file','utf8').trim().split('\n').filter(Boolean).map(JSON.parse); process.exit(($expr)?0:1)" 2>/dev/null; then
		ok "$desc"
	else
		bad "$desc"
	fi
}

scn_done() {
	echo "  → $PASS passed, $FAIL failed"
	[ "$FAIL" -eq 0 ]
}
