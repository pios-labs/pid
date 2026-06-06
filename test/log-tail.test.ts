import { appendFile, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { FileTailer } from "../src/log/tail.js";

let dir: string;
let path: string;
let tailers: FileTailer[];

beforeEach(async () => {
	dir = await mkdtemp(join(tmpdir(), "pid-tail-"));
	path = join(dir, "x.jsonl");
	tailers = [];
});
afterEach(async () => {
	for (const t of tailers) t.stop();
	await rm(dir, { recursive: true, force: true });
});

function follow(opts?: { fromStart?: boolean }): string[] {
	const lines: string[] = [];
	const t = new FileTailer(path, (l) => lines.push(l), { intervalMs: 40, ...opts });
	tailers.push(t);
	t.start();
	return lines;
}

async function waitForLen(arr: unknown[], n: number, timeoutMs = 2500): Promise<void> {
	const start = Date.now();
	while (Date.now() - start < timeoutMs) {
		if (arr.length >= n) return;
		await sleep(20);
	}
	throw new Error(`timed out waiting for ${n} lines (have ${arr.length})`);
}

describe("FileTailer", () => {
	it("emits only newly-appended lines by default (skips pre-existing content)", async () => {
		await writeFile(path, "old\n");
		const lines = follow();
		await sleep(80); // let it settle past the existing content
		await appendFile(path, "new1\nnew2\n");
		await waitForLen(lines, 2);
		expect(lines).toEqual(["new1", "new2"]);
	});

	it("emits existing content first when fromStart is set", async () => {
		await writeFile(path, "a\nb\n");
		const lines = follow({ fromStart: true });
		await waitForLen(lines, 2);
		await appendFile(path, "c\n");
		await waitForLen(lines, 3);
		expect(lines).toEqual(["a", "b", "c"]);
	});

	it("reopens across a rotation (live file replaced) — tail -F semantics", async () => {
		await writeFile(path, "seed\n");
		const lines = follow();
		await sleep(80);
		await appendFile(path, "before-roll\n");
		await waitForLen(lines, 1);

		// Rotate: move the live file aside and create a fresh, smaller one.
		await rm(path, { force: true });
		await writeFile(path, "after-roll\n");
		await waitForLen(lines, 2);
		expect(lines).toEqual(["before-roll", "after-roll"]);
	});

	it("handles a partial line split across two appends", async () => {
		await writeFile(path, "");
		const lines = follow();
		await sleep(80);
		await appendFile(path, "{half"); // no newline yet
		await sleep(80);
		expect(lines).toEqual([]); // not emitted until the line completes
		await appendFile(path, "-rest}\n");
		await waitForLen(lines, 1);
		expect(lines).toEqual(["{half-rest}"]);
	});
});
