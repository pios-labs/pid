#!/usr/bin/env node
// Stand-in for `pi --mode rpc` that exercises the host->pi (stdin) direction used by
// Supervisor.send(). Reads strict LF-framed JSONL from stdin and echoes each parsed
// object back to stdout as `{ type: "stdin_echo", received: <obj> }`, so a test can
// prove the line was framed correctly and reached pi's stdin. Mirrors fake-pi.mjs for
// the graceful stdin-close teardown (flush a final event, exit 0).
process.stdout.write(`${JSON.stringify({ type: "agent_start" })}\n`);

const keepAlive = setInterval(() => {}, 1000);

let buffer = "";
process.stdin.resume();
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => {
	buffer += chunk;
	let nl = buffer.indexOf("\n");
	while (nl !== -1) {
		const line = buffer.slice(0, nl);
		buffer = buffer.slice(nl + 1);
		if (line.length > 0) {
			process.stdout.write(`${JSON.stringify({ type: "stdin_echo", received: JSON.parse(line) })}\n`);
		}
		nl = buffer.indexOf("\n");
	}
});
process.stdin.on("end", () => {
	process.stdout.write(`${JSON.stringify({ type: "session_shutdown" })}\n`, () => {
		clearInterval(keepAlive);
		process.exit(0);
	});
});
