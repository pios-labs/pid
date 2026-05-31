import { describe, expect, it } from "vitest";
import { assertValidTimeZone, dayWindow, localDateKey, weekWindow } from "../src/util/time.js";

describe("assertValidTimeZone", () => {
	it("accepts valid IANA zones", () => {
		expect(() => assertValidTimeZone("UTC")).not.toThrow();
		expect(() => assertValidTimeZone("America/New_York")).not.toThrow();
		expect(() => assertValidTimeZone("Europe/London")).not.toThrow();
	});

	it("throws on invalid zones", () => {
		expect(() => assertValidTimeZone("Not/AZone")).toThrow(/invalid time zone/);
		expect(() => assertValidTimeZone("")).toThrow();
	});
});

describe("dayWindow", () => {
	it("aligns to midnight in UTC", () => {
		const w = dayWindow(new Date("2026-06-01T13:37:00Z"), "UTC");
		expect(w.start.toISOString()).toBe("2026-06-01T00:00:00.000Z");
		expect(w.end.toISOString()).toBe("2026-06-02T00:00:00.000Z");
	});

	it("aligns to local midnight in a western zone (EDT, UTC-4 in June)", () => {
		// 01:00 EDT, still June 1 locally
		const w = dayWindow(new Date("2026-06-01T05:00:00Z"), "America/New_York");
		expect(w.start.toISOString()).toBe("2026-06-01T04:00:00.000Z");
		expect(w.end.toISOString()).toBe("2026-06-02T04:00:00.000Z");
	});

	it("produces a 23h day across spring-forward DST (NY, 2026-03-08)", () => {
		const w = dayWindow(new Date("2026-03-08T12:00:00Z"), "America/New_York");
		expect(w.start.toISOString()).toBe("2026-03-08T05:00:00.000Z"); // midnight EST (UTC-5)
		expect(w.end.toISOString()).toBe("2026-03-09T04:00:00.000Z"); // midnight EDT (UTC-4)
		expect(w.end.getTime() - w.start.getTime()).toBe(23 * 3600 * 1000);
	});
});

describe("weekWindow", () => {
	it("starts Monday at local midnight (UTC)", () => {
		// 2026-06-03 is a Wednesday; the ISO week runs Mon 2026-06-01 → Mon 2026-06-08
		const w = weekWindow(new Date("2026-06-03T12:00:00Z"), "UTC");
		expect(w.start.toISOString()).toBe("2026-06-01T00:00:00.000Z");
		expect(w.end.toISOString()).toBe("2026-06-08T00:00:00.000Z");
	});

	it("treats Monday itself as the window start, not the prior week", () => {
		const w = weekWindow(new Date("2026-06-01T12:00:00Z"), "UTC");
		expect(w.start.toISOString()).toBe("2026-06-01T00:00:00.000Z");
	});
});

describe("localDateKey", () => {
	it("formats the local date in the zone", () => {
		expect(localDateKey(new Date("2026-06-01T05:00:00Z"), "UTC")).toBe("2026-06-01");
		// 23:30 UTC May 31 is 19:30 EDT May 31 in New York
		expect(localDateKey(new Date("2026-05-31T23:30:00Z"), "America/New_York")).toBe("2026-05-31");
	});
});
