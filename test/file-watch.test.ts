import { describe, expect, it } from "vitest";
import {
	diffListings,
	type FileWatchConfig,
	FileWatchManager,
	type Listing,
	type PollTimer,
} from "../src/triggers/file-watch.js";

describe("diffListings (ADR 0014)", () => {
	const L = (o: Record<string, number>): Listing => new Map(Object.entries(o));

	it("detects add, change, and unlink", () => {
		expect([...diffListings(L({ a: 1 }), L({ a: 1, b: 1 }))]).toEqual(["add"]);
		expect([...diffListings(L({ a: 1 }), L({ a: 2 }))]).toEqual(["change"]);
		expect([...diffListings(L({ a: 1 }), L({}))]).toEqual(["unlink"]);
		expect(diffListings(L({ a: 1 }), L({ a: 1 })).size).toBe(0); // no change
	});
});

// Controllable poll timer: nothing fires until tick().
function fakePoll() {
	const fns: Array<() => void> = [];
	const timer: PollTimer = {
		set: (fn) => {
			fns.push(fn);
			return fns.length - 1;
		},
		clear: () => {},
	};
	return {
		timer,
		tick: () => {
			for (const f of fns) f();
		},
	};
}

function harness(events: FileWatchConfig["events"]) {
	let listing: Listing = new Map();
	const fired: string[] = [];
	const poll = fakePoll();
	const mgr = new FileWatchManager({
		actions: { fire: (n) => void fired.push(n) },
		scan: () => new Map(listing),
		timers: poll.timer,
	});
	const set = (o: Record<string, number>) => {
		listing = new Map(Object.entries(o));
	};
	return { mgr, fired, poll, set, config: { type: "file_watch" as const, path: "/x", events } };
}

describe("FileWatchManager", () => {
	it("baselines on register — pre-existing files do not fire", () => {
		const h = harness(["add"]);
		h.set({ a: 1 }); // already present when armed
		h.mgr.register("svc", h.config);
		h.poll.tick();
		expect(h.fired).toEqual([]); // no NEW file since arm
	});

	it("fires a job when a watched event occurs", () => {
		const h = harness(["add"]);
		h.mgr.register("svc", h.config);
		h.set({ a: 1 }); // a file lands
		h.poll.tick();
		expect(h.fired).toEqual(["svc"]);
	});

	it("ignores events not in the configured set", () => {
		const h = harness(["add"]); // only adds
		h.set({ a: 1 });
		h.mgr.register("svc", h.config); // baseline {a:1}
		h.set({ a: 2 }); // a CHANGE, not an add
		h.poll.tick();
		expect(h.fired).toEqual([]);
	});

	it("unregister stops the watcher; dispose clears all", () => {
		const h = harness(["add"]);
		h.mgr.register("svc", h.config);
		h.mgr.unregister("svc");
		expect(h.mgr.has("svc")).toBe(false);
		h.set({ a: 1 });
		h.poll.tick();
		expect(h.fired).toEqual([]);
	});

	it("register is idempotent on an unchanged config (no baseline reset)", () => {
		const h = harness(["add"]);
		h.mgr.register("svc", h.config);
		h.set({ a: 1 }); // lands after arm
		h.mgr.register("svc", { ...h.config }); // re-sync with same config → must NOT re-baseline
		h.poll.tick();
		expect(h.fired).toEqual(["svc"]); // the add since the ORIGINAL arm still fires
	});
});
