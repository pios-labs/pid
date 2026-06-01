#!/usr/bin/env node
// Stand-in for `pi --mode rpc` that "spends": emits one assistant message_end
// carrying full usage (cost + the four token components extractUsage requires),
// then stays alive until told to stop. Used by the cost-governor integration test.
process.stdout.write(`${JSON.stringify({ type: "agent_start" })}\n`);

const keepAlive = setInterval(() => {}, 1000);

// Emit the billed message only after the supervisor's spawn-settle window (100ms), so the
// breach→pause happens against a service that has already reached "running" — as real pi does
// (it takes seconds to produce a message, never within the settle window).
setTimeout(() => {
	process.stdout.write(
		`${JSON.stringify({
			type: "message_end",
			message: {
				role: "assistant",
				timestamp: Date.now(),
				usage: {
					input: 1000,
					output: 500,
					cacheRead: 0,
					cacheWrite: 0,
					cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 1.0 },
				},
			},
		})}\n`,
	);
}, 300);
process.stdin.resume();
process.stdin.on("end", () => {
	process.stdout.write(`${JSON.stringify({ type: "session_shutdown" })}\n`, () => {
		clearInterval(keepAlive);
		process.exit(0);
	});
});
