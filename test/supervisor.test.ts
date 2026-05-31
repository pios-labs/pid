import { chmod, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { serviceSchema } from "../src/services/schema.js";
import type { ServiceRecord } from "../src/supervisor/index.js";

const fixturePath = fileURLToPath(new URL("fixtures/fake-pi.mjs", import.meta.url));

// paths.ts reads PID_HOME at module-eval time, so set it before importing anything
// that pulls it in, then load the modules dynamically.
let tmp: string;
let Supervisor: typeof import("../src/supervisor/index.js").Supervisor;
let StateStore: typeof import("../src/state/store.js").StateStore;

beforeAll(async () => {
	tmp = await mkdtemp(join(tmpdir(), "pid-test-"));
	process.env.PID_HOME = tmp;
	const [sup, state] = await Promise.all([import("../src/supervisor/index.js"), import("../src/state/store.js")]);
	Supervisor = sup.Supervisor;
	StateStore = state.StateStore;
	await chmod(fixturePath, 0o755);
});

afterAll(async () => {
	await rm(tmp, { recursive: true, force: true });
});

async function waitForLog(path: string, needle: string, timeoutMs = 3000): Promise<string> {
	const start = Date.now();
	while (Date.now() - start < timeoutMs) {
		try {
			const text = await readFile(path, "utf8");
			if (text.includes(needle)) return text;
		} catch {
			// log not written yet
		}
		await sleep(25);
	}
	throw new Error(`timed out waiting for "${needle}" in ${path}`);
}

describe("Supervisor.start", () => {
	it("spawns a subprocess, streams events to the log, and reaches running", async () => {
		const state = await StateStore.open();
		const config = serviceSchema.parse({ name: "fake", command: fixturePath });
		const sup = new Supervisor({ state, services: { services: [config], errors: [] } });

		const res = await sup.start("fake");
		expect(res.state).toBe("running");

		const rec = sup.status("fake") as ServiceRecord;
		expect(rec.state).toBe("running");
		expect(rec.pid).toBeGreaterThan(0);
		expect(rec.startedAt).toBeTruthy();

		const logText = await waitForLog(join(tmp, "logs", "fake.jsonl"), "message_end");
		expect(logText).toContain('"agent_start"');
		expect(logText).toContain('"message_end"');
		expect(logText).toContain("pid_parse_error"); // malformed line was caught, not fatal

		await sup.shutdown();
		expect((sup.status("fake") as ServiceRecord).state).toBe("stopped");
		expect((sup.status("fake") as ServiceRecord).pid).toBeUndefined();
	});

	it("rejects starting a service that is already running", async () => {
		const state = await StateStore.open();
		const config = serviceSchema.parse({ name: "dup", command: fixturePath });
		const sup = new Supervisor({ state, services: { services: [config], errors: [] } });

		await sup.start("dup");
		await expect(sup.start("dup")).rejects.toThrow(/already running/);
		await sup.shutdown();
	});

	it("marks a service failed when the command cannot be spawned", async () => {
		const state = await StateStore.open();
		const config = serviceSchema.parse({ name: "nope", command: "/nonexistent/pid-fake-binary" });
		const sup = new Supervisor({ state, services: { services: [config], errors: [] } });

		await expect(sup.start("nope")).rejects.toThrow(/failed to start nope/);
		expect((sup.status("nope") as ServiceRecord).state).toBe("failed");
	});
});

describe("Supervisor.stop", () => {
	it("stops via stdin-close, capturing pi's flushed tail and reaching stopped", async () => {
		const state = await StateStore.open();
		const config = serviceSchema.parse({ name: "graceful", command: fixturePath });
		const sup = new Supervisor({ state, services: { services: [config], errors: [] } });

		await sup.start("graceful");
		const res = await sup.stop("graceful");

		expect(res.state).toBe("stopped");
		const rec = sup.status("graceful") as ServiceRecord;
		expect(rec.state).toBe("stopped");
		expect(rec.pid).toBeUndefined();

		// The "session_shutdown" line is only emitted by the fixture AFTER stdin closes; its presence
		// proves we took the graceful stdin-close path and kept the reader attached through shutdown.
		const logText = await readFile(join(tmp, "logs", "graceful.jsonl"), "utf8");
		expect(logText).toContain('"session_shutdown"');
	});

	it("is idempotent when the service is not running", async () => {
		const state = await StateStore.open();
		const config = serviceSchema.parse({ name: "idle", command: fixturePath });
		const sup = new Supervisor({ state, services: { services: [config], errors: [] } });

		const res = await sup.stop("idle");
		expect(res.state).toBe("stopped");
	});

	it("throws on an unknown service", async () => {
		const state = await StateStore.open();
		const sup = new Supervisor({ state, services: { services: [], errors: [] } });
		await expect(sup.stop("ghost")).rejects.toThrow(/unknown service/);
	});
});
