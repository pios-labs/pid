import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { BudgetConfig, TimerService } from "../src/governor/index.js";

let tmp: string;
let BudgetStore: typeof import("../src/budget/store.js").BudgetStore;
let CostGovernor: typeof import("../src/governor/index.js").CostGovernor;
let extractUsage: typeof import("../src/governor/index.js").extractUsage;
let evaluateBreach: typeof import("../src/governor/index.js").evaluateBreach;

const T0 = Date.parse("2026-06-01T10:00:00Z"); // a Monday

function messageEnd(costUsd: number, tokens: number, at: number = T0): unknown {
	return {
		type: "message_end",
		message: {
			role: "assistant",
			timestamp: at,
			usage: {
				input: tokens,
				output: 0,
				cacheRead: 0,
				cacheWrite: 0,
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: costUsd },
			},
		},
	};
}

// Test doubles: capturing actions + timers + a fixed clock.
function harness() {
	const calls = { pause: [] as string[], resume: [] as string[] };
	const actions = {
		pause: async (n: string) => {
			calls.pause.push(n);
		},
		resume: async (n: string) => {
			calls.resume.push(n);
		},
	};
	const armed: Array<{ fn: () => void; ms: number }> = [];
	const timers: TimerService = {
		set: (fn, ms) => {
			const h = { fn, ms };
			armed.push(h);
			return h;
		},
		clear: () => {},
	};
	let nowMs = T0;
	return {
		calls,
		actions,
		armed,
		timers,
		now: () => nowMs,
		setNow: (n: number) => {
			nowMs = n;
		},
	};
}

const pauseCaps: BudgetConfig = { daily_usd: 1.0, on_exceed: "pause", reset_tz: "UTC" };

beforeAll(async () => {
	tmp = await mkdtemp(join(tmpdir(), "pid-gov-"));
	process.env.PID_HOME = tmp;
	const [store, gov] = await Promise.all([import("../src/budget/store.js"), import("../src/governor/index.js")]);
	BudgetStore = store.BudgetStore;
	CostGovernor = gov.CostGovernor;
	extractUsage = gov.extractUsage;
	evaluateBreach = gov.evaluateBreach;
});

afterAll(async () => {
	await rm(tmp, { recursive: true, force: true });
});

describe("extractUsage", () => {
	it("sums the four token components and reads cost.total + timestamp", () => {
		const u = extractUsage(
			{
				type: "message_end",
				message: {
					role: "assistant",
					timestamp: T0,
					usage: { input: 10, output: 20, cacheRead: 30, cacheWrite: 40, cost: { total: 0.5 } },
				},
			},
			999,
		);
		expect(u).toEqual({ costUsd: 0.5, tokens: 100, at: new Date(T0) });
	});

	it("falls back to now when the message has no timestamp", () => {
		const u = extractUsage(
			{
				type: "message_end",
				message: { role: "assistant", usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, cost: { total: 0.1 } } },
			},
			12345,
		);
		expect(u?.at).toEqual(new Date(12345));
	});

	it("ignores non-usage, non-assistant, and malformed events", () => {
		expect(extractUsage({ type: "agent_start" }, T0)).toBeNull();
		expect(extractUsage({ type: "message_end", message: { role: "user" } }, T0)).toBeNull();
		expect(extractUsage({ type: "message_end", message: { role: "assistant" } }, T0)).toBeNull();
		expect(extractUsage("not json", T0)).toBeNull();
		expect(extractUsage(null, T0)).toBeNull();
	});
});

describe("evaluateBreach", () => {
	const snap = {
		spentUsdDay: 2,
		spentUsdWeek: 5,
		tokensDay: 1000,
		dayEnd: new Date("2026-06-02T00:00:00Z"),
		weekEnd: new Date("2026-06-08T00:00:00Z"),
	};

	it("flags only the caps that are reached", () => {
		const breached = evaluateBreach(snap, {
			daily_usd: 1,
			weekly_usd: 10,
			daily_tokens: 2000,
			on_exceed: "pause",
			reset_tz: "UTC",
		});
		expect(breached.map((b) => b.cap)).toEqual(["daily_usd"]);
	});

	it("returns empty when within budget", () => {
		expect(evaluateBreach(snap, { daily_usd: 100, on_exceed: "pause", reset_tz: "UTC" })).toEqual([]);
	});
});

describe("CostGovernor", () => {
	let h: ReturnType<typeof harness>;
	let n = 0;
	const svc = () => `svc-${n}`;

	beforeEach(() => {
		h = harness();
		n += 1;
	});

	it("notify mode records a breach but does not pause", async () => {
		const store = await BudgetStore.open(svc());
		const gov = new CostGovernor({ actions: h.actions, now: h.now, timers: h.timers });
		gov.register(svc(), { daily_usd: 1.0, on_exceed: "notify", reset_tz: "UTC" }, store);

		await gov.handleEvent(svc(), messageEnd(1.5, 100));

		expect(h.calls.pause).toEqual([]);
		expect(h.armed).toEqual([]);
		expect(gov.status(svc())?.paused).toBe(false);
		expect(gov.status(svc())?.breachedCaps?.map((b) => b.cap)).toEqual(["daily_usd"]);
	});

	it("pause mode stops on breach and arms resume at the daily window end", async () => {
		const store = await BudgetStore.open(svc());
		const gov = new CostGovernor({ actions: h.actions, now: h.now, timers: h.timers });
		gov.register(svc(), pauseCaps, store);

		await gov.handleEvent(svc(), messageEnd(0.5, 10)); // under
		expect(h.calls.pause).toEqual([]);

		await gov.handleEvent(svc(), messageEnd(0.6, 10)); // 1.1 >= 1.0 -> breach
		expect(h.calls.pause).toEqual([svc()]);
		expect(gov.status(svc())?.paused).toBe(true);
		// resume at 2026-06-02T00:00Z, now = 2026-06-01T10:00Z -> 14h
		expect(h.armed).toHaveLength(1);
		expect(h.armed[0]?.ms).toBe(14 * 3600 * 1000);
	});

	it("resuming via the timer clears the paused state and calls resume", async () => {
		const store = await BudgetStore.open(svc());
		const gov = new CostGovernor({ actions: h.actions, now: h.now, timers: h.timers });
		gov.register(svc(), pauseCaps, store);
		await gov.handleEvent(svc(), messageEnd(1.5, 10));

		h.armed[0]?.fn();
		await Promise.resolve();

		expect(h.calls.resume).toEqual([svc()]);
		expect(gov.status(svc())?.paused).toBe(false);
		expect(gov.status(svc())?.breachedCaps).toBeNull();
	});

	it("times resume to the weekly window end when only the weekly cap is breached", async () => {
		const store = await BudgetStore.open(svc());
		const gov = new CostGovernor({ actions: h.actions, now: h.now, timers: h.timers });
		gov.register(svc(), { daily_usd: 100, weekly_usd: 1.0, on_exceed: "pause", reset_tz: "UTC" }, store);

		await gov.handleEvent(svc(), messageEnd(1.5, 10)); // weekly breach only
		// resume at next Monday 2026-06-08T00:00Z, now 2026-06-01T10:00Z -> 6d14h
		expect(h.armed[0]?.ms).toBe((6 * 24 + 14) * 3600 * 1000);
	});

	it("does not re-pause an already-paused service, but keeps charging", async () => {
		const store = await BudgetStore.open(svc());
		const gov = new CostGovernor({ actions: h.actions, now: h.now, timers: h.timers });
		gov.register(svc(), pauseCaps, store);

		await gov.handleEvent(svc(), messageEnd(1.5, 10)); // breach -> pause
		await gov.handleEvent(svc(), messageEnd(0.5, 10)); // in-flight event after pause

		expect(h.calls.pause).toEqual([svc()]); // only once
		expect(h.armed).toHaveLength(1);
	});

	it("recover() re-holds a service still over budget on boot", async () => {
		const name = svc();
		const pre = await BudgetStore.open(name);
		await pre.record({ costUsd: 5.0, tokens: 10 }, new Date(T0), "UTC"); // already over a $1 cap

		const gov = new CostGovernor({ actions: h.actions, now: h.now, timers: h.timers });
		gov.register(name, pauseCaps, await BudgetStore.open(name));

		const { stillPaused } = await gov.recover(name);
		expect(stillPaused).toBe(true);
		expect(gov.status(name)?.paused).toBe(true);
		expect(h.armed).toHaveLength(1); // resume re-armed
	});

	it("recover() clears a service whose window has since expired", async () => {
		const name = svc();
		const pre = await BudgetStore.open(name);
		await pre.record({ costUsd: 5.0, tokens: 10 }, new Date(T0), "UTC");

		// Boot a week later: the daily+weekly windows have rolled, spend reset.
		h.setNow(Date.parse("2026-06-09T10:00:00Z"));
		const gov = new CostGovernor({ actions: h.actions, now: h.now, timers: h.timers });
		gov.register(name, pauseCaps, await BudgetStore.open(name));

		const { stillPaused } = await gov.recover(name);
		expect(stillPaused).toBe(false);
		expect(gov.status(name)?.paused).toBe(false);
	});
});
