import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

// paths.ts reads PID_HOME at module-eval time, so set it before importing.
let tmp: string;
let BudgetStore: typeof import("../src/budget/store.js").BudgetStore;

const tz = "UTC";
const mon = new Date("2026-06-01T10:00:00Z"); // Monday
const tue = new Date("2026-06-02T10:00:00Z"); // next day, same week
const nextMon = new Date("2026-06-08T10:00:00Z"); // next week

beforeAll(async () => {
	tmp = await mkdtemp(join(tmpdir(), "pid-budget-"));
	process.env.PID_HOME = tmp;
	BudgetStore = (await import("../src/budget/store.js")).BudgetStore;
});

afterAll(async () => {
	await rm(tmp, { recursive: true, force: true });
});

describe("BudgetStore", () => {
	it("accumulates cost and tokens within a window", async () => {
		const store = await BudgetStore.open("accumulate");
		let snap = await store.record({ costUsd: 0.5, tokens: 1000 }, mon, tz);
		expect(snap.spentUsdDay).toBeCloseTo(0.5);
		expect(snap.spentUsdWeek).toBeCloseTo(0.5);
		expect(snap.tokensDay).toBe(1000);

		snap = await store.record({ costUsd: 0.25, tokens: 500 }, mon, tz);
		expect(snap.spentUsdDay).toBeCloseTo(0.75);
		expect(snap.spentUsdWeek).toBeCloseTo(0.75);
		expect(snap.tokensDay).toBe(1500);
	});

	it("rolls the daily window but carries the weekly window across days", async () => {
		const store = await BudgetStore.open("roll-day");
		await store.record({ costUsd: 0.75, tokens: 1500 }, mon, tz);

		const snap = await store.record({ costUsd: 0.1, tokens: 200 }, tue, tz);
		// daily reset then charged
		expect(snap.spentUsdDay).toBeCloseTo(0.1);
		expect(snap.tokensDay).toBe(200);
		// weekly carries
		expect(snap.spentUsdWeek).toBeCloseTo(0.85);
		// day end advanced to Tuesday's boundary
		expect(snap.dayEnd.toISOString()).toBe("2026-06-03T00:00:00.000Z");
	});

	it("rolls the weekly window across a week boundary", async () => {
		const store = await BudgetStore.open("roll-week");
		await store.record({ costUsd: 0.75, tokens: 1500 }, mon, tz);

		const snap = await store.record({ costUsd: 0.2, tokens: 300 }, nextMon, tz);
		expect(snap.spentUsdWeek).toBeCloseTo(0.2); // weekly reset
		expect(snap.spentUsdDay).toBeCloseTo(0.2); // daily reset too
		expect(snap.weekEnd.toISOString()).toBe("2026-06-15T00:00:00.000Z");
	});

	it("persists across reopen", async () => {
		const first = await BudgetStore.open("persist");
		await first.record({ costUsd: 0.42, tokens: 800 }, mon, tz);

		const second = await BudgetStore.open("persist");
		const snap = await second.refresh(mon, tz); // same window, no roll
		expect(snap.spentUsdDay).toBeCloseTo(0.42);
		expect(snap.tokensDay).toBe(800);
	});

	it("refresh rolls an expired window down to zero (boot recovery)", async () => {
		const store = await BudgetStore.open("recover");
		await store.record({ costUsd: 5.0, tokens: 9000 }, mon, tz);

		// Daemon "restarts" a week later: the window has expired, spend resets.
		const snap = await store.refresh(nextMon, tz);
		expect(snap.spentUsdDay).toBe(0);
		expect(snap.spentUsdWeek).toBe(0);
	});

	it("reset() zeroes the current windows", async () => {
		const store = await BudgetStore.open("reset");
		await store.record({ costUsd: 1.0, tokens: 2000 }, mon, tz);
		await store.reset(mon, tz);
		const snap = await store.refresh(mon, tz);
		expect(snap.spentUsdDay).toBe(0);
		expect(snap.spentUsdWeek).toBe(0);
	});
});

describe("BudgetStore override", () => {
	it("merges per-dimension entries and surfaces them on the snapshot", async () => {
		const store = await BudgetStore.open("ov-merge");
		let snap = await store.setOverride({ daily_usd: 10 }, mon, tz);
		expect(snap.override).toEqual({ daily_usd: 10 });

		snap = await store.setOverride({ weekly_usd: null }, mon, tz); // merge, don't replace
		expect(snap.override).toEqual({ daily_usd: 10, weekly_usd: null });
	});

	it("persists the override across reopen", async () => {
		const first = await BudgetStore.open("ov-persist");
		await first.setOverride({ daily_usd: null }, mon, tz);

		const second = await BudgetStore.open("ov-persist");
		const snap = await second.refresh(mon, tz);
		expect(snap.override).toEqual({ daily_usd: null });
	});

	it("clears daily override entries when the daily window rolls, keeping the weekly one", async () => {
		const store = await BudgetStore.open("ov-roll-day");
		await store.setOverride({ daily_usd: 10, weekly_usd: 50 }, mon, tz);

		const snap = await store.refresh(tue, tz); // next day, same week
		expect(snap.override).toEqual({ weekly_usd: 50 });
	});

	it("clears the weekly override when the weekly window rolls", async () => {
		const store = await BudgetStore.open("ov-roll-week");
		await store.setOverride({ weekly_usd: 50 }, mon, tz);

		const snap = await store.refresh(nextMon, tz);
		expect(snap.override).toBeUndefined();
	});

	it("reset() drops any override", async () => {
		const store = await BudgetStore.open("ov-reset");
		await store.setOverride({ daily_usd: null }, mon, tz);
		await store.reset(mon, tz);
		const snap = await store.refresh(mon, tz);
		expect(snap.override).toBeUndefined();
	});
});
