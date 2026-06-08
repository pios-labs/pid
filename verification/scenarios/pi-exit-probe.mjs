// Probe real pi's teardown exit code — the empirical premise behind pid's stop() choice (ADR 0001).
// Usage: node pi-exit-probe.mjs <stdin|sigterm>
//   stdin   → close pi's stdin (the graceful path pid uses): pi takes shutdown(0) → flush → exit 0
//   sigterm → send SIGTERM (pi's own RpcClient path):        pi takes shutdown(143) → SKIP flush → exit 143
// pi installs a SIGTERM handler that calls process.exit(143), so a SIGTERM death surfaces as exit
// CODE 143 (not signal:"SIGTERM"); asserting code===143 proves the handler (and its flush-skip) ran.
import { spawn } from "node:child_process";

const mode = process.argv[2];
const child = spawn("pi", ["--mode", "rpc", "--session-id", "s6probe"], { stdio: ["pipe", "pipe", "ignore"] });

let acted = false;
const act = () => {
	if (acted) return;
	acted = true;
	clearTimeout(fallback);
	// Small settle so pi has fully installed its stdin-end / signal handlers before we tear down.
	setTimeout(() => {
		if (mode === "sigterm") child.kill("SIGTERM");
		else child.stdin.end();
	}, 300);
};

// pi emits a startup line as soon as it is up; act on it, or fall back to a fixed delay.
child.stdout.once("data", act);
const fallback = setTimeout(act, 2500);

child.on("exit", (code, signal) => {
	process.stdout.write(JSON.stringify({ code, signal }));
	process.exit(0);
});
child.on("error", (err) => {
	process.stdout.write(JSON.stringify({ error: err.message }));
	process.exit(0);
});
