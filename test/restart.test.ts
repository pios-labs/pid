import { describe, expect, it } from "vitest";
import type { TimerService } from "../src/governor/cost.js";
import { Relauncher, type RestartConfig } from "../src/governor/restart.js";

// Controllable timer service: nothing fires until the test fires it, so backoff scheduling is
// deterministic (the supervisor integration is exercised separately against real pi in s10).
function fakeTimers() {
	let seq = 0;
	const pending = new Map<number, { fn: () => void; ms: number }>();
	const svc: TimerService = {
		set: (fn, ms) => {
			const id = ++seq;
			pending.set(id, { fn, ms });
			return id;
		},
		clear: (h) => {
			pending.delete(h as number);
		},
	};
	return {
		svc,
		count: () => pending.size,
		delays: () => [...pending.values()].map((p) => p.ms),
		fireAll: () => {
			for (const [id, e] of [...pending]) {
				pending.delete(id);
				e.fn();
			}
		},
	};
}

function harness(over: Partial<RestartConfig> = {}) {
	const starts: string[] = [];
	const timers = fakeTimers();
	const relauncher = new Relauncher({ actions: { start: async (n) => void starts.push(n) }, timers: timers.svc });
	const config: RestartConfig = {
		policy: "on-failure",
		max_consecutive: 3,
		backoff: { initial_ms: 100, max_ms: 1000, factor: 2 },
		...over,
	};
	relauncher.register("svc", config);
	return { relauncher, starts, timers };
}

const failed = { failed: true, uptimeMs: 0 };
const clean = { failed: false, uptimeMs: 0 };

describe("Relauncher policy", () => {
	it("does not relaunch a service that never reached running (a failed first start)", () => {
		const h = harness({ policy: "always" });
		// No markStarted → ineligible: a misconfigured first start fails loudly, never loops.
		expect(h.relauncher.onExit("svc", failed).action).toBe("none");
		expect(h.timers.count()).toBe(0);
	});

	it("on-failure relaunches a failure but not a clean exit", () => {
		const h = harness({ policy: "on-failure" });
		h.relauncher.markStarted("svc");
		expect(h.relauncher.onExit("svc", clean).action).toBe("none");
		expect(h.relauncher.onExit("svc", failed).action).toBe("relaunch");
	});

	it("always relaunches both clean and failed unexpected exits", () => {
		const h = harness({ policy: "always" });
		h.relauncher.markStarted("svc");
		expect(h.relauncher.onExit("svc", clean).action).toBe("relaunch");
		h.relauncher.markStarted("svc");
		expect(h.relauncher.onExit("svc", failed).action).toBe("relaunch");
	});

	it("never never relaunches", () => {
		const h = harness({ policy: "never" });
		h.relauncher.markStarted("svc");
		expect(h.relauncher.onExit("svc", failed).action).toBe("none");
	});

	it("fires the injected start when the backoff timer elapses", () => {
		const h = harness();
		h.relauncher.markStarted("svc");
		h.relauncher.onExit("svc", failed);
		expect(h.starts).toEqual([]); // armed, not fired
		h.timers.fireAll();
		expect(h.starts).toEqual(["svc"]);
	});
});

describe("Relauncher backoff + give-up", () => {
	it("backs off exponentially, capped at max_ms, with rising attempt numbers", () => {
		const h = harness({ max_consecutive: 10, backoff: { initial_ms: 100, max_ms: 350, factor: 2 } });
		const delays: number[] = [];
		for (let i = 0; i < 4; i++) {
			h.relauncher.markStarted("svc"); // each relaunch reaches running, then fails fast again
			const d = h.relauncher.onExit("svc", failed);
			expect(d.action).toBe("relaunch");
			expect(d.attempt).toBe(i + 1);
			delays.push(d.delayMs);
		}
		// 100, 200, 400→capped 350, 800→capped 350
		expect(delays).toEqual([100, 200, 350, 350]);
	});

	it("gives up at max_consecutive consecutive fast failures", () => {
		const h = harness({ max_consecutive: 3 });
		let last = "";
		for (let i = 0; i < 4; i++) {
			h.relauncher.markStarted("svc");
			last = h.relauncher.onExit("svc", failed).action;
		}
		// attempts 1,2,3 relaunch; the 4th observation hits the cap → give-up
		expect(last).toBe("give-up");
	});

	it("a stable run (uptime ≥ max_ms) resets the flap counter", () => {
		const h = harness({ max_consecutive: 3, backoff: { initial_ms: 100, max_ms: 1000, factor: 2 } });
		// Two fast failures climb the counter.
		h.relauncher.markStarted("svc");
		expect(h.relauncher.onExit("svc", { failed: true, uptimeMs: 10 }).attempt).toBe(1);
		h.relauncher.markStarted("svc");
		expect(h.relauncher.onExit("svc", { failed: true, uptimeMs: 10 }).attempt).toBe(2);
		// A long, stable run then a crash: counter reset → back to attempt 1, not climbing to give-up.
		h.relauncher.markStarted("svc");
		expect(h.relauncher.onExit("svc", { failed: true, uptimeMs: 5000 }).attempt).toBe(1);
	});
});

describe("Relauncher cancel/dispose", () => {
	it("cancel disarms a pending relaunch and makes the service ineligible", () => {
		const h = harness({ policy: "always" });
		h.relauncher.markStarted("svc");
		h.relauncher.onExit("svc", failed);
		expect(h.timers.count()).toBe(1);
		h.relauncher.cancel("svc");
		expect(h.timers.count()).toBe(0);
		// Ineligible until it next reaches running (cancel cleared `started`).
		expect(h.relauncher.onExit("svc", failed).action).toBe("none");
	});

	it("isEligible tracks the reached-running gate across cancel", () => {
		const h = harness();
		expect(h.relauncher.isEligible("svc")).toBe(false);
		h.relauncher.markStarted("svc");
		expect(h.relauncher.isEligible("svc")).toBe(true);
		h.relauncher.cancel("svc");
		expect(h.relauncher.isEligible("svc")).toBe(false);
	});

	it("dispose clears every pending timer", () => {
		const h = harness({ policy: "always" });
		h.relauncher.markStarted("svc");
		h.relauncher.onExit("svc", failed);
		expect(h.timers.count()).toBe(1);
		h.relauncher.dispose();
		expect(h.timers.count()).toBe(0);
	});
});
