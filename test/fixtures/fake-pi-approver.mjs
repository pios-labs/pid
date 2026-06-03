#!/usr/bin/env node
// Stand-in for `pi --mode rpc` that exercises the approval router end to end. Emits a
// tool_execution_start (a bash command) immediately followed by a confirm dialog, then echoes
// back any extension_ui_response it receives on stdin as a "ui_response_seen" event — so a test
// can prove the router correlated the dialog, decided, and replied over stdin. Graceful
// stdin-close teardown mirrors fake-pi.mjs.
process.stdout.write(
	`${JSON.stringify({ type: "tool_execution_start", toolCallId: "tc_1", toolName: "bash", args: { command: "ls -la" } })}\n`,
);
process.stdout.write(
	`${JSON.stringify({ type: "extension_ui_request", id: "req-1", method: "confirm", title: "Bash", message: "Run: ls -la ?" })}\n`,
);

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
			process.stdout.write(`${JSON.stringify({ type: "ui_response_seen", received: JSON.parse(line) })}\n`);
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
