import { existsSync } from "node:fs";
import { mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { RotatingLogWriter } from "../src/log/writer.js";

let dir: string;

beforeEach(async () => {
	dir = await mkdtemp(join(tmpdir(), "pid-rot-"));
});
afterEach(async () => {
	await rm(dir, { recursive: true, force: true });
});

const live = (name: string) => join(dir, `${name}.jsonl`);

/** Poll until the (possibly async) predicate holds. Async fs here — WriteStream flush and the
 *  fire-and-forget prune are not awaitable from the writer's API — so the tests observe via the disk. */
async function waitFor(pred: () => boolean | Promise<boolean>, timeoutMs = 2000): Promise<void> {
	const start = Date.now();
	while (Date.now() - start < timeoutMs) {
		if (await pred()) return;
		await sleep(15);
	}
	throw new Error("waitFor timed out");
}

async function readSafe(path: string): Promise<string> {
	try {
		return await readFile(path, "utf8");
	} catch {
		return "";
	}
}

describe("RotatingLogWriter", () => {
	it("appends lines to the live file at the documented path", async () => {
		const w = await RotatingLogWriter.open(dir, "svc");
		w.write("a\n");
		w.write("b\n");
		w.end();
		await waitFor(async () => (await readSafe(live("svc"))) === "a\nb\n");
		expect(await readSafe(live("svc"))).toBe("a\nb\n");
	});

	it("rolls to a dated archive when the calendar day changes, live continues fresh", async () => {
		let clock = new Date(2026, 0, 1, 10, 0, 0); // 2026-01-01 local
		const w = await RotatingLogWriter.open(dir, "svc", { now: () => clock });
		w.write("day1\n");

		clock = new Date(2026, 0, 2, 9, 0, 0); // next day
		w.write("day2\n");
		w.end();

		const archive = join(dir, "svc.2026-01-01.jsonl");
		await waitFor(() => existsSync(archive) && existsSync(live("svc")));
		expect(await readSafe(archive)).toBe("day1\n");
		await waitFor(async () => (await readSafe(live("svc"))) === "day2\n");
		expect(await readSafe(live("svc"))).toBe("day2\n");
	});

	it("rolls to a time-stamped archive when the size cap is breached mid-day", async () => {
		const clock = new Date(2026, 0, 1, 10, 0, 0);
		const w = await RotatingLogWriter.open(dir, "svc", { now: () => clock, sizeCapBytes: 8 });
		w.write("12345\n"); // 6 bytes — fits
		w.write("67890\n"); // would push past 8 — rolls first
		w.end();

		const archive = join(dir, "svc.2026-01-01T10-00-00.jsonl");
		await waitFor(() => existsSync(archive) && existsSync(live("svc")));
		expect(await readSafe(archive)).toBe("12345\n");
		await waitFor(async () => (await readSafe(live("svc"))) === "67890\n");
		expect(await readSafe(live("svc"))).toBe("67890\n");
	});

	it("prunes archives older than the retention window on roll", async () => {
		// An ancient archive that must be pruned, and a recent one that must survive.
		await writeFile(join(dir, "svc.2020-01-01.jsonl"), "old\n");
		await writeFile(join(dir, "svc.2026-01-01.jsonl"), "recent\n");

		let clock = new Date(2026, 0, 2, 10, 0, 0);
		const w = await RotatingLogWriter.open(dir, "svc", { now: () => clock, retentionDays: 30 });
		w.write("seed\n");
		clock = new Date(2026, 0, 3, 10, 0, 0); // next day → triggers a roll → triggers prune
		w.write("next\n");
		w.end();

		await waitFor(() => !existsSync(join(dir, "svc.2020-01-01.jsonl")));
		expect(existsSync(join(dir, "svc.2020-01-01.jsonl"))).toBe(false); // pruned
		expect(existsSync(join(dir, "svc.2026-01-01.jsonl"))).toBe(true); // within window, kept
	});

	it("leaves writes intact after end() and no-ops further writes", async () => {
		const w = await RotatingLogWriter.open(dir, "svc");
		w.write("kept\n");
		w.end();
		w.write("dropped\n"); // post-end: ignored, must not throw
		await waitFor(async () => (await readSafe(live("svc"))) === "kept\n");
		await sleep(50);
		expect(await readSafe(live("svc"))).toBe("kept\n"); // "dropped" never landed
	});

	it("seeds the segment from an existing file's day, rolling stale content on the first new-day write", async () => {
		// First session writes some content; a later session on a different day reopens the same file.
		const first = await RotatingLogWriter.open(dir, "svc");
		first.write("from-prior-session\n");
		first.end();
		await waitFor(async () => (await readSafe(live("svc"))) === "from-prior-session\n");

		// Reopen with the clock advanced past the file's mtime day → first write rolls the stale content.
		const future = new Date(Date.now() + 3 * 24 * 60 * 60 * 1000); // +3 days
		const second = await RotatingLogWriter.open(dir, "svc", { now: () => future });
		second.write("new-session\n");
		second.end();

		await waitFor(async () => (await readSafe(live("svc"))) === "new-session\n");
		expect(await readSafe(live("svc"))).toBe("new-session\n");
		// The prior content was archived under some dated name (not the live path).
		const archives = (await readdir(dir)).filter((f) => f.startsWith("svc.2") && f.endsWith(".jsonl"));
		expect(archives.length).toBeGreaterThanOrEqual(1);
		expect(await readSafe(join(dir, archives[0] as string))).toBe("from-prior-session\n");
	});
});
