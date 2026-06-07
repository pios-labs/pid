import { chmod, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { serviceSchema } from "../src/services/schema.js";
import type { ServiceRecord, ServiceStatus } from "../src/supervisor/index.js";

const fixturePath = fileURLToPath(new URL("fixtures/fake-pi.mjs", import.meta.url));
const spenderPath = fileURLToPath(new URL("fixtures/fake-pi-spender.mjs", import.meta.url));
const crasherPath = fileURLToPath(new URL("fixtures/fake-pi-crasher.mjs", import.meta.url));
const echoPath = fileURLToPath(new URL("fixtures/fake-pi-echo.mjs", import.meta.url));
const approverPath = fileURLToPath(new URL("fixtures/fake-pi-approver.mjs", import.meta.url));

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
	await chmod(spenderPath, 0o755);
	await chmod(crasherPath, 0o755);
	await chmod(echoPath, 0o755);
	await chmod(approverPath, 0o755);
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
		expect(logText).not.toContain('"message_update"'); // streaming frame dropped from the chronicle (ADR 0009)

		// Every line is enveloped (ADR 0005): parse the first and check the documented contract.
		const env = JSON.parse(logText.trim().split("\n")[0] ?? "{}");
		expect(env).toMatchObject({ v: 1, service: "fake", source: "pi", type: "agent_start" });
		expect(typeof env.ts).toBe("string");
		expect(env.data).toMatchObject({ type: "agent_start" }); // pi event preserved verbatim under data

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

describe("Supervisor cost-governor integration", () => {
	async function waitForState(sup: InstanceType<typeof Supervisor>, name: string, want: string, timeoutMs = 3000) {
		const start = Date.now();
		while (Date.now() - start < timeoutMs) {
			if ((sup.status(name) as ServiceRecord).state === want) return;
			await sleep(25);
		}
		throw new Error(`timed out waiting for ${name} to reach ${want} (got ${(sup.status(name) as ServiceRecord).state})`);
	}

	it("pauses a service that breaches its daily_usd cap", async () => {
		const state = await StateStore.open();
		// $1 message vs a $0.50 cap → breach on the first assistant message.
		const config = serviceSchema.parse({ name: "spendy", command: spenderPath, budget: { daily_usd: 0.5 } });
		const sup = new Supervisor({ state, services: { services: [config], errors: [] } });
		await sup.init();

		await sup.start("spendy");
		await waitForState(sup, "spendy", "paused");

		const rec = sup.status("spendy") as ServiceRecord;
		expect(rec.state).toBe("paused");
		expect(rec.pid).toBeUndefined(); // pause stops the process

		// The intervention lands in the real chronicle (observability mandate): a documented
		// pid_budget_pause line, written before the pause stop while the stream was still open.
		const logText = await waitForLog(join(tmp, "logs", "spendy.jsonl"), '"type":"pid_budget_pause"');
		const pause = logText
			.trim()
			.split("\n")
			.map((l) => JSON.parse(l))
			.find((e) => e.type === "pid_budget_pause");
		expect(pause.source).toBe("pid");
		expect(pause.data.by).toBe("governor");
		expect(pause.data.breached[0].cap).toBe("daily_usd");

		await sup.shutdown();
	});

	it("refuses a bare start of a budget-paused service, but resume() works", async () => {
		const state = await StateStore.open();
		const config = serviceSchema.parse({ name: "held", command: spenderPath, budget: { daily_usd: 0.5 } });
		const sup = new Supervisor({ state, services: { services: [config], errors: [] } });
		await sup.init();

		await sup.start("held");
		await waitForState(sup, "held", "paused");

		await expect(sup.start("held")).rejects.toThrow(/budget-paused/);

		await sup.resume("held");
		expect((sup.status("held") as ServiceRecord).state).toBe("running");

		await sup.shutdown();
	});

	it("does not auto-resume a budget-paused service that the user manually stops", async () => {
		const state = await StateStore.open();
		const config = serviceSchema.parse({ name: "manual", command: spenderPath, budget: { daily_usd: 0.5 } });
		const sup = new Supervisor({ state, services: { services: [config], errors: [] } });
		await sup.init();

		await sup.start("manual");
		await waitForState(sup, "manual", "paused");

		const res = await sup.stop("manual");
		expect(res.state).toBe("stopped");
		expect((sup.status("manual") as ServiceRecord).state).toBe("stopped");

		await sup.shutdown();
	});
});

describe("Supervisor crash-detector integration", () => {
	async function waitForState(sup: InstanceType<typeof Supervisor>, name: string, want: string, timeoutMs = 3000) {
		const start = Date.now();
		while (Date.now() - start < timeoutMs) {
			if ((sup.status(name) as ServiceRecord).state === want) return;
			await sleep(25);
		}
		throw new Error(`timed out waiting for ${name} to reach ${want} (got ${(sup.status(name) as ServiceRecord).state})`);
	}

	it("quarantines a service that repeats the same failure past the threshold", async () => {
		const state = await StateStore.open();
		const config = serviceSchema.parse({ name: "crashy", command: crasherPath });
		const sup = new Supervisor({ state, services: { services: [config], errors: [] } });
		await sup.init();

		await sup.start("crashy");
		await waitForState(sup, "crashy", "quarantined");

		const rec = sup.status("crashy") as ServiceRecord;
		expect(rec.state).toBe("quarantined");
		expect(rec.pid).toBeUndefined(); // quarantine gracefully stops the process
		expect(rec.lastFailure?.signature).toBe("tool:bash:error"); // the "why" is surfaced

		// The terminal bit is persisted (ADR 0003) so a restart keeps holding it.
		expect(await state.getQuarantined()).toContain("crashy");

		// The intervention lands in the real chronicle (observability mandate): a documented
		// pid_quarantine line, written before the quarantine stop while the stream was still open.
		const logText = await waitForLog(join(tmp, "logs", "crashy.jsonl"), '"type":"pid_quarantine"');
		const quar = logText
			.trim()
			.split("\n")
			.map((l) => JSON.parse(l))
			.find((e) => e.type === "pid_quarantine");
		expect(quar.source).toBe("pid");
		expect(quar.data).toMatchObject({ signature: "tool:bash:error", threshold: 3, by: "crash_detector" });

		await sup.shutdown();
	});

	it("refuses a bare start of a quarantined service; unquarantine clears it and allows start", async () => {
		const state = await StateStore.open();
		const config = serviceSchema.parse({ name: "quar-refuse", command: crasherPath });
		const sup = new Supervisor({ state, services: { services: [config], errors: [] } });
		await sup.init();

		await sup.start("quar-refuse");
		await waitForState(sup, "quar-refuse", "quarantined");

		await expect(sup.start("quar-refuse")).rejects.toThrow(/quarantined/);

		const res = await sup.unquarantine("quar-refuse");
		expect(res.state).toBe("stopped");
		expect(await state.getQuarantined()).not.toContain("quar-refuse");

		// Cleared → can be started again (it will re-quarantine, but the point is start() is allowed).
		await sup.start("quar-refuse");
		expect((sup.status("quar-refuse") as ServiceRecord).state).toBe("running");

		await sup.shutdown();
	});

	it("re-holds a quarantined service across a daemon restart and never auto-starts it", async () => {
		// First daemon: enable + start, let it quarantine, persist.
		const state1 = await StateStore.open();
		const config = serviceSchema.parse({ name: "quar-persist", command: crasherPath });
		const sup1 = new Supervisor({ state: state1, services: { services: [config], errors: [] } });
		await sup1.init();
		await sup1.enable("quar-persist");
		await sup1.start("quar-persist");
		await waitForState(sup1, "quar-persist", "quarantined");
		await sup1.shutdown();

		// Second daemon: fresh state load + fresh supervisor over the same persisted state.
		const state2 = await StateStore.open();
		const sup2 = new Supervisor({ state: state2, services: { services: [config], errors: [] } });
		await sup2.init();
		// init() restored the terminal bit from the persisted set...
		expect((sup2.status("quar-persist") as ServiceRecord).state).toBe("quarantined");
		// ...and startEnabled must not start it back into the loop despite it being enabled.
		await sup2.startEnabled();
		expect((sup2.status("quar-persist") as ServiceRecord).state).toBe("quarantined");

		await sup2.unquarantine("quar-persist");
		await sup2.disable("quar-persist");
		await sup2.shutdown();
	});
});

describe("Supervisor approval router integration", () => {
	it("auto-approves a confirm under the trusting posture and replies over stdin", async () => {
		const state = await StateStore.open();
		// no gate, on_unmatched defaults to approve → the confirm for `ls -la` auto-approves
		const config = serviceSchema.parse({ name: "auto-appr", command: approverPath });
		const sup = new Supervisor({ state, services: { services: [config], errors: [] } });

		await sup.start("auto-appr");

		// The fixture echoes the reply it received; its appearance proves the router correlated the
		// dialog to the in-flight bash tool, classified it approve, and replied over stdin.
		const logText = await waitForLog(join(tmp, "logs", "auto-appr.jsonl"), "ui_response_seen");
		expect(logText).toContain('"decision":"auto_approve"');
		expect(logText).toContain('"received":{"type":"extension_ui_response","id":"req-1","confirmed":true}');
		expect(sup.listApprovals()).toHaveLength(0);

		await sup.shutdown();
	});

	it("enqueues a gated confirm, then `approve` replies over stdin and clears the inbox", async () => {
		const state = await StateStore.open();
		const config = serviceSchema.parse({ name: "gated-appr", command: approverPath, gate: ["bash:ls"] });
		const sup = new Supervisor({ state, services: { services: [config], errors: [] } });

		await sup.start("gated-appr");

		// `ls` is gated → enqueue, no reply yet.
		await waitForLog(join(tmp, "logs", "gated-appr.jsonl"), '"phase":"enqueue"');
		const pending = sup.listApprovals();
		expect(pending).toHaveLength(1);
		expect(pending[0]).toMatchObject({ id: "req-1", service: "gated-appr", command: "ls -la" });

		// Human approves → reply goes over stdin, fixture echoes it, inbox clears.
		await sup.approveRequest("req-1");
		const logText = await waitForLog(join(tmp, "logs", "gated-appr.jsonl"), "ui_response_seen");
		expect(logText).toContain('"decision":"approve"');
		expect(sup.listApprovals()).toHaveLength(0);

		await sup.shutdown();
	});
});

describe("Supervisor.send", () => {
	it("writes a framed JSONL line that reaches pi's stdin", async () => {
		const state = await StateStore.open();
		const config = serviceSchema.parse({ name: "echo", command: echoPath });
		const sup = new Supervisor({ state, services: { services: [config], errors: [] } });

		await sup.start("echo");
		const reply = { type: "extension_ui_response", id: "req_1", confirmed: true };
		await sup.send("echo", reply);

		// The echo fixture parses the line off its stdin and re-emits it; its appearance in the
		// log proves the message was framed correctly and delivered over stdin end-to-end.
		const logText = await waitForLog(join(tmp, "logs", "echo.jsonl"), "stdin_echo");
		expect(logText).toContain('"received":{"type":"extension_ui_response","id":"req_1","confirmed":true}');

		await sup.shutdown();
	});

	it("throws on an unknown service", async () => {
		const state = await StateStore.open();
		const sup = new Supervisor({ state, services: { services: [], errors: [] } });
		await expect(sup.send("ghost", { type: "x" })).rejects.toThrow(/unknown service/);
	});

	it("rejects when the service is not running", async () => {
		const state = await StateStore.open();
		const config = serviceSchema.parse({ name: "idle-send", command: echoPath });
		const sup = new Supervisor({ state, services: { services: [config], errors: [] } });
		await expect(sup.send("idle-send", { type: "x" })).rejects.toThrow(/not running/);
	});

	it("rejects after the service has stopped (stdin closed)", async () => {
		const state = await StateStore.open();
		const config = serviceSchema.parse({ name: "stopped-send", command: echoPath });
		const sup = new Supervisor({ state, services: { services: [config], errors: [] } });

		await sup.start("stopped-send");
		await sup.stop("stopped-send");
		await expect(sup.send("stopped-send", { type: "x" })).rejects.toThrow(/not running|not writable/);
	});
});

describe("StateStore concurrent persists (snag S1)", () => {
	it("survives many concurrent persists on one store without an ENOENT rename race", async () => {
		const store = await StateStore.open();
		// Fire 20 state-changing ops at once; each calls persist(). Pre-fix these collided on a single
		// `state.json.tmp` and the losers threw ENOENT on rename.
		const ops = Array.from({ length: 20 }, (_, i) => store.setEnabled(`svc-${i}`, true));
		await expect(Promise.all(ops)).resolves.toBeDefined();

		const reloaded = await StateStore.open();
		expect(await reloaded.getEnabled()).toHaveLength(20);
	});

	it("survives two stores sharing one PID_HOME persisting concurrently", async () => {
		// The exact flaky-test shape from the snag: two StateStore instances over one PID_HOME.
		const [a, b] = await Promise.all([StateStore.open(), StateStore.open()]);
		const ops = [
			...Array.from({ length: 15 }, (_, i) => a.setQuarantined(`a-${i}`, true)),
			...Array.from({ length: 15 }, (_, i) => b.setQuarantined(`b-${i}`, true)),
		];
		await expect(Promise.all(ops)).resolves.toBeDefined();
		// Last-writer-wins across instances means we can't assert the merged set; the contract here is
		// simply that no write threw — the file is intact and parseable on the next open.
		await expect(StateStore.open()).resolves.toBeDefined();
	});
});

describe("Supervisor.reload (ADR 0010)", () => {
	it("registers a newly-present service (add) and makes it startable", async () => {
		const state = await StateStore.open();
		const a = serviceSchema.parse({ name: "rl-add-a", command: fixturePath });
		const b = serviceSchema.parse({ name: "rl-add-b", command: fixturePath });
		const sup = new Supervisor({ state, services: { services: [a], errors: [] } });

		const summary = await sup.reload({ services: [a, b], errors: [] });
		expect(summary.added).toEqual(["rl-add-b"]);
		expect((sup.status("rl-add-b") as ServiceRecord).state).toBe("stopped");

		await sup.start("rl-add-b");
		expect((sup.status("rl-add-b") as ServiceRecord).state).toBe("running");
		await sup.shutdown();
	});

	it("deregisters a removed, not-running service (remove)", async () => {
		const state = await StateStore.open();
		const a = serviceSchema.parse({ name: "rl-rm-a", command: fixturePath });
		const b = serviceSchema.parse({ name: "rl-rm-b", command: fixturePath });
		const sup = new Supervisor({ state, services: { services: [a, b], errors: [] } });

		const summary = await sup.reload({ services: [a], errors: [] });
		expect(summary.removed).toEqual(["rl-rm-b"]);
		expect(() => sup.status("rl-rm-b")).toThrow(/unknown service/);
	});

	it("orphans a running service whose file is removed, then deregisters it on its terminal stop", async () => {
		const state = await StateStore.open();
		const a = serviceSchema.parse({ name: "rl-orphan", command: fixturePath });
		const sup = new Supervisor({ state, services: { services: [a], errors: [] } });

		await sup.start("rl-orphan");
		const summary = await sup.reload({ services: [], errors: [] });
		expect(summary.orphaned).toEqual(["rl-orphan"]);

		const rec = sup.status("rl-orphan") as ServiceStatus;
		expect(rec.orphaned).toBe(true);
		expect(rec.state).toBe("running"); // never interrupted (ADR 0010)

		// The removal is announced in the live chronicle before any stop.
		const log = await waitForLog(join(tmp, "logs", "rl-orphan.jsonl"), "pid_config_changed");
		expect(log).toContain('"change":"removed"');

		// Stopping an orphan is terminal (no definition to restart from) — it deregisters.
		await sup.stop("rl-orphan");
		expect(() => sup.status("rl-orphan")).toThrow(/unknown service/);
	});

	it("stages a modified running service and applies it only on restart (never mid-run)", async () => {
		const state = await StateStore.open();
		const v1 = serviceSchema.parse({ name: "rl-stage", command: fixturePath });
		const v2 = serviceSchema.parse({ name: "rl-stage", command: fixturePath, env: { FOO: "bar" } });
		const sup = new Supervisor({ state, services: { services: [v1], errors: [] } });

		await sup.start("rl-stage");
		const summary = await sup.reload({ services: [v2], errors: [] });
		expect(summary.staged).toEqual(["rl-stage"]);

		let rec = sup.status("rl-stage") as ServiceStatus;
		expect(rec.configChanged).toBe(true);
		expect(rec.config.env).not.toEqual({ FOO: "bar" }); // live process keeps its old config
		const log = await waitForLog(join(tmp, "logs", "rl-stage.jsonl"), "pid_config_changed");
		expect(log).toContain('"change":"modified"');

		await sup.restart("rl-stage"); // a restart is when the staged config takes effect
		rec = sup.status("rl-stage") as ServiceStatus;
		expect(rec.configChanged).toBe(false);
		expect(rec.config.env).toEqual({ FOO: "bar" });
		await sup.shutdown();
	});

	it("applies a modified, not-running service immediately (update)", async () => {
		const state = await StateStore.open();
		const v1 = serviceSchema.parse({ name: "rl-update", command: fixturePath });
		const v2 = serviceSchema.parse({ name: "rl-update", command: fixturePath, env: { FOO: "bar" } });
		const sup = new Supervisor({ state, services: { services: [v1], errors: [] } });

		const summary = await sup.reload({ services: [v2], errors: [] });
		expect(summary.updated).toEqual(["rl-update"]);
		const rec = sup.status("rl-update") as ServiceStatus;
		expect(rec.configChanged).toBe(false);
		expect(rec.config.env).toEqual({ FOO: "bar" });
	});

	it("treats an unchanged set as a no-op and leaves a running service untouched", async () => {
		const state = await StateStore.open();
		const a = serviceSchema.parse({ name: "rl-noop", command: fixturePath });
		const sup = new Supervisor({ state, services: { services: [a], errors: [] } });

		await sup.start("rl-noop");
		const summary = await sup.reload({ services: [a], errors: [] });
		expect(summary).toMatchObject({ added: [], removed: [], updated: [], staged: [], orphaned: [] });

		const rec = sup.status("rl-noop") as ServiceStatus;
		expect(rec.state).toBe("running");
		expect(rec.configChanged).toBe(false);
		expect(rec.orphaned).toBeFalsy();
		await sup.shutdown();
	});

	it("cancels a staged change when the file is reverted to the live config", async () => {
		const state = await StateStore.open();
		const v1 = serviceSchema.parse({ name: "rl-revert", command: fixturePath });
		const v2 = serviceSchema.parse({ name: "rl-revert", command: fixturePath, env: { FOO: "bar" } });
		const sup = new Supervisor({ state, services: { services: [v1], errors: [] } });

		await sup.start("rl-revert");
		await sup.reload({ services: [v2], errors: [] });
		expect((sup.status("rl-revert") as ServiceStatus).configChanged).toBe(true);

		const summary = await sup.reload({ services: [v1], errors: [] });
		expect(summary.staged).toEqual([]);
		expect((sup.status("rl-revert") as ServiceStatus).configChanged).toBe(false);
		await sup.shutdown();
	});

	it("clears the orphaned flag when the file reappears", async () => {
		const state = await StateStore.open();
		const a = serviceSchema.parse({ name: "rl-restore", command: fixturePath });
		const sup = new Supervisor({ state, services: { services: [a], errors: [] } });

		await sup.start("rl-restore");
		await sup.reload({ services: [], errors: [] });
		expect((sup.status("rl-restore") as ServiceStatus).orphaned).toBe(true);

		const summary = await sup.reload({ services: [a], errors: [] });
		expect(summary.orphaned).toEqual([]);
		expect((sup.status("rl-restore") as ServiceStatus).orphaned).toBeFalsy();
		await sup.shutdown();
	});

	it("passes load errors through without disturbing existing services", async () => {
		const state = await StateStore.open();
		const a = serviceSchema.parse({ name: "rl-err", command: fixturePath });
		const sup = new Supervisor({ state, services: { services: [a], errors: [] } });

		const summary = await sup.reload({ services: [a], errors: [{ file: "bad.yaml", error: "boom" }] });
		expect(summary.errors).toEqual([{ file: "bad.yaml", error: "boom" }]);
		expect((sup.status("rl-err") as ServiceRecord).state).toBe("stopped");
	});

	it("preserves runtime state (enabled) across a reload", async () => {
		const state = await StateStore.open();
		const v1 = serviceSchema.parse({ name: "rl-enabled", command: fixturePath });
		const v2 = serviceSchema.parse({ name: "rl-enabled", command: fixturePath, env: { FOO: "bar" } });
		const sup = new Supervisor({ state, services: { services: [v1], errors: [] } });

		await sup.enable("rl-enabled");
		await sup.reload({ services: [v2], errors: [] });
		expect(await state.getEnabled()).toContain("rl-enabled");
	});

	it("enable/disable return a structured payload so `--json` is valid (not undefined)", async () => {
		const state = await StateStore.open();
		const a = serviceSchema.parse({ name: "en-payload", command: fixturePath });
		const sup = new Supervisor({ state, services: { services: [a], errors: [] } });

		expect(await sup.enable("en-payload")).toEqual({ name: "en-payload", enabled: true });
		expect(await sup.disable("en-payload")).toEqual({ name: "en-payload", enabled: false });
	});
});
