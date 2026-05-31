#!/usr/bin/env node
// Minimal stand-in for `pi --mode rpc` used by the supervisor tests.
// Ignores every CLI flag pid injects; emits a couple of JSONL events plus one
// deliberately malformed line, then stays alive until terminated.
process.stdout.write(`${JSON.stringify({ type: "agent_start" })}\n`);
process.stdout.write(
	`${JSON.stringify({ type: "message_end", message: { role: "assistant", usage: { cost: { total: 0.01 } } } })}\n`,
);
process.stdout.write("this is not json\n"); // exercises the malformed-line path
setInterval(() => {}, 1000); // keep the process alive until SIGTERM
