import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { type LogFilter, listSegments, matchesFilter, parseSince, readChronicle } from "../src/log/reader.js";
import type { LogEnvelope } from "../src/util/log.js";

let dir: string;
beforeEach(async () => {
	dir = await mkdtemp(join(tmpdir(), "pid-rd-"));
});
afterEach(async () => {
	await rm(dir, { recursive: true, force: true });
});

const env = (ts: string, type: string, source: "pi" | "pid" = "pi", data: unknown = {}): LogEnvelope => ({
	v: 1,
	ts,
	service: "svc",
	source,
	type,
	data,
});
const line = (e: LogEnvelope) => `${JSON.stringify(e)}\n`;

async function collect(filter: LogFilter): Promise<LogEnvelope[]> {
	const out: LogEnvelope[] = [];
	await readChronicle(dir, "svc", filter, (e) => out.push(e));
	return out;
}

describe("listSegments", () => {
	it("orders archives chronologically with the live file last", async () => {
		// Intentionally written out of order; a plain <date> is the day's *tail* (rolled at midnight),
		// so it must sort after that day's intraday size-roll archive.
		await writeFile(join(dir, "svc.jsonl"), "");
		await writeFile(join(dir, "svc.2026-06-04.jsonl"), "");
		await writeFile(join(dir, "svc.2026-06-03.jsonl"), "");
		await writeFile(join(dir, "svc.2026-06-04T14-12-00.jsonl"), "");
		await writeFile(join(dir, "other.2026-06-04.jsonl"), ""); // a different service — must be ignored

		const segs = (await listSegments(dir, "svc")).map((p) => p.slice(dir.length + 1));
		expect(segs).toEqual(["svc.2026-06-03.jsonl", "svc.2026-06-04T14-12-00.jsonl", "svc.2026-06-04.jsonl", "svc.jsonl"]);
	});

	it("returns [] when the logs dir doesn't exist", async () => {
		expect(await listSegments(join(dir, "nope"), "svc")).toEqual([]);
	});
});

describe("readChronicle", () => {
	beforeEach(async () => {
		await writeFile(
			join(dir, "svc.2026-06-04.jsonl"),
			line(env("2026-06-04T10:00:00.000Z", "agent_start")) + line(env("2026-06-04T10:00:05.000Z", "message_end")),
		);
		await writeFile(
			join(dir, "svc.jsonl"),
			line(env("2026-06-05T09:00:00.000Z", "tool_execution_start")) +
				line(env("2026-06-05T09:00:01.000Z", "pid_budget_pause", "pid")),
		);
	});

	it("stitches archives then live, in order", async () => {
		expect((await collect({})).map((e) => e.type)).toEqual([
			"agent_start",
			"message_end",
			"tool_execution_start",
			"pid_budget_pause",
		]);
	});

	it("filters by type, source, and since (envelope ts)", async () => {
		expect((await collect({ type: "message_end" })).map((e) => e.type)).toEqual(["message_end"]);
		expect((await collect({ source: "pid" })).map((e) => e.type)).toEqual(["pid_budget_pause"]);
		expect((await collect({ since: new Date("2026-06-05T00:00:00.000Z") })).map((e) => e.type)).toEqual([
			"tool_execution_start",
			"pid_budget_pause",
		]);
	});
});

describe("parseSince", () => {
	const now = new Date("2026-06-05T12:00:00.000Z");
	it("parses relative ages", () => {
		expect(parseSince("30m", now).toISOString()).toBe("2026-06-05T11:30:00.000Z");
		expect(parseSince("2h", now).toISOString()).toBe("2026-06-05T10:00:00.000Z");
		expect(parseSince("7d", now).toISOString()).toBe("2026-05-29T12:00:00.000Z");
	});
	it("parses an absolute ISO timestamp", () => {
		expect(parseSince("2026-06-01T00:00:00.000Z", now).toISOString()).toBe("2026-06-01T00:00:00.000Z");
	});
	it("throws on garbage", () => {
		expect(() => parseSince("yesterday", now)).toThrow(/invalid --since/);
	});
});

describe("matchesFilter", () => {
	it("is true when every set field matches and ignores unset fields", () => {
		const e = env("2026-06-05T09:00:00.000Z", "tool_execution_start", "pi");
		expect(matchesFilter(e, {})).toBe(true);
		expect(matchesFilter(e, { type: "tool_execution_start", source: "pi" })).toBe(true);
		expect(matchesFilter(e, { type: "message_end" })).toBe(false);
		expect(matchesFilter(e, { since: new Date("2026-06-06T00:00:00.000Z") })).toBe(false);
	});
});
