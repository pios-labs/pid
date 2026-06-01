#!/usr/bin/env node
// Stand-in for `pi --mode rpc` that "crash-loops": emits the same failing-tool event
// repeatedly (same signature → tool:bash:error), enough to cross the default quarantine
// threshold (3 in the window). Used by the crash-detector integration test.
process.stdout.write(`${JSON.stringify({ type: "agent_start" })}\n`);

const keepAlive = setInterval(() => {}, 1000);

// Emit the failures only after the supervisor's spawn-settle window (100ms), so the
// quarantine happens against a service that has already reached "running" — as real pi does.
function fail(i) {
	setTimeout(
		() => {
			process.stdout.write(
				`${JSON.stringify({
					type: "tool_execution_end",
					toolCallId: `tc${i}`,
					toolName: "bash",
					result: "command not found",
					isError: true,
				})}\n`,
			);
		},
		200 + i * 50,
	);
}
fail(0);
fail(1);
fail(2);

process.stdin.resume();
process.stdin.on("end", () => {
	process.stdout.write(`${JSON.stringify({ type: "session_shutdown" })}\n`, () => {
		clearInterval(keepAlive);
		process.exit(0);
	});
});
