import { type ChildProcess, spawn } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

// End-to-end against the built CLI (CI builds before `npm test`). Proves `pid tail`'s dynamic
// follow-set (ADR 0008, amended): an empty start waits instead of erroring, and a service that begins
// logging *after* launch is discovered on the next rescan and streamed from its first event.
const cli = fileURLToPath(new URL("../dist/cli.js", import.meta.url));

let home: string;
let child: ChildProcess | undefined;

beforeEach(async () => {
	home = await mkdtemp(join(tmpdir(), "pid-clitail-"));
});
afterEach(async () => {
	child?.kill("SIGKILL");
	child = undefined;
	await rm(home, { recursive: true, force: true });
});

async function waitFor(get: () => string, needle: string, timeoutMs = 6000): Promise<void> {
	const start = Date.now();
	while (Date.now() - start < timeoutMs) {
		if (get().includes(needle)) return;
		await sleep(50);
	}
	throw new Error(`timed out waiting for ${JSON.stringify(needle)}; saw: ${JSON.stringify(get())}`);
}

describe("pid tail — dynamic follow-set", () => {
	it("waits on an empty start, then picks up a service that begins logging (from its first event)", async () => {
		let out = "";
		let err = "";
		child = spawn(process.execPath, [cli, "tail", "--raw"], { env: { ...process.env, PID_HOME: home } });
		child.stdout?.on("data", (b) => {
			out += b;
		});
		child.stderr?.on("data", (b) => {
			err += b;
		});

		// Empty logs dir → it waits rather than erroring out.
		await waitFor(() => err, "waiting");

		// A service begins logging after launch.
		const logs = join(home, "logs");
		await mkdir(logs, { recursive: true });
		const line = JSON.stringify({
			v: 1,
			ts: "2026-06-07T16:30:00.000Z",
			service: "late",
			source: "pi",
			type: "agent_start",
			data: {},
		});
		await writeFile(join(logs, "late.jsonl"), `${line}\n`);

		// Discovered on the next rescan: announced on stderr, streamed from its start on stdout.
		await waitFor(() => err, "following late");
		await waitFor(() => out, '"type":"agent_start"');
		expect(out).toContain('"service":"late"');
	}, 20000);
});
