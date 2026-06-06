#!/usr/bin/env node
// Minimal stand-in for `pi --mode rpc` used by the supervisor tests.
// Ignores every CLI flag pid injects; emits a couple of JSONL events plus one
// deliberately malformed line, then stays alive until told to stop.
//
// Models pi's two relevant teardown behaviors (see Supervisor.stop()):
//   - stdin EOF  -> flush a final event, then exit 0   (pi's shutdown(0) path)
//   - SIGTERM    -> exit via signal, no final flush     (pi's shutdown(143) path)
process.stdout.write(`${JSON.stringify({ type: "agent_start" })}\n`);
// A streaming frame pid must NOT persist to the chronicle (ADR 0009) — onServiceEvent still sees it.
process.stdout.write(
	`${JSON.stringify({ type: "message_update", assistantMessageEvent: { type: "text_delta", delta: "hi", partial: {} } })}\n`,
);
process.stdout.write(
	`${JSON.stringify({ type: "message_end", message: { role: "assistant", usage: { cost: { total: 0.01 } } } })}\n`,
);
process.stdout.write("this is not json\n"); // exercises the malformed-line path

const keepAlive = setInterval(() => {}, 1000); // stay alive until stdin closes or a signal arrives

// Graceful path: when pid closes our stdin, mirror pi by flushing a final event before exiting 0.
// The "session_shutdown" line is the tail pid must capture — proof the reader stays attached through shutdown.
process.stdin.resume();
process.stdin.on("end", () => {
	process.stdout.write(`${JSON.stringify({ type: "session_shutdown" })}\n`, () => {
		clearInterval(keepAlive);
		process.exit(0);
	});
});
