import { spawn } from "node:child_process";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { beforeAll, describe, expect, it } from "vitest";

/**
 * Fixture-drift guard — the regression armor for the failure that started the verification campaign.
 *
 * For two weeks the fake-pi fixtures emitted pi-shaped events that were subtly MORE GENEROUS / a
 * different shape than what real pi emits, and nothing compared the two — so green fixture tests lied.
 * This test makes that drift LOUD: it spawns each fixture, collects the events it actually emits, and
 * asserts their load-bearing shapes still match the committed REAL captures in verification/captures/.
 *
 * If a fixture is ever edited to be more cooperative than reality (e.g. tool_execution_end.result
 * reverts to a bare string), or pi changes a shape and a capture is refreshed without updating the
 * fixture, this test goes red. The captures are the source of truth; the fixtures must mirror them.
 *
 * Runs in plain `npm test` (no pi binary needed) — it reads committed captures, not a live pi.
 */

type Json = Record<string, unknown>;

const fixUrl = (n: string) => fileURLToPath(new URL(`fixtures/${n}`, import.meta.url));
const capUrl = (n: string) => fileURLToPath(new URL(`../verification/captures/${n}`, import.meta.url));

/** Cast a parsed-JSON value to an object for property access (defensive: null/undefined → {}). */
const obj = (v: unknown): Json => (v && typeof v === "object" ? (v as Json) : {});
/** Read a nested field by path, returning unknown (no `any`). */
const at = (v: unknown, ...path: string[]): unknown => path.reduce<unknown>((acc, k) => obj(acc)[k], v);

/** Parse a committed real capture (enveloped: { …, type, data } where data is pi's raw event). */
function realCapture(file: string): Json[] {
	return readFileSync(capUrl(file), "utf8")
		.trim()
		.split("\n")
		.filter(Boolean)
		.map((l) => JSON.parse(l) as Json);
}

/** The raw pi event of a given type from a capture (this is what in-process consumers receive). */
function realData(file: string, type: string, pred: (d: unknown) => boolean = () => true): Json {
	const env = realCapture(file).find((e) => e.type === type && pred(e.data));
	if (!env) throw new Error(`no ${type} (matching pred) in ${file}`);
	return obj(env.data);
}

/** Spawn a fixture and collect the raw JSONL events it emits within a window, then tear it down. */
function collectFixture(name: string, windowMs = 900): Promise<Json[]> {
	return new Promise((resolve) => {
		const child = spawn(process.execPath, [fixUrl(name)], { stdio: ["pipe", "pipe", "ignore"] });
		let buf = "";
		const events: Json[] = [];
		child.stdout.on("data", (b: Buffer) => {
			buf += b.toString();
			let nl = buf.indexOf("\n");
			while (nl !== -1) {
				const line = buf.slice(0, nl).trim();
				buf = buf.slice(nl + 1);
				if (line) {
					try {
						events.push(JSON.parse(line) as Json);
					} catch {
						/* the deliberately-malformed line in fake-pi.mjs */
					}
				}
				nl = buf.indexOf("\n");
			}
		});
		setTimeout(() => {
			try {
				child.stdin.end();
			} catch {
				/* already gone */
			}
			child.kill();
			resolve(events);
		}, windowMs);
	});
}

/** Assert every key in `keys` exists on `fixture` with the same JS type as on the `real` reference. */
function sameShape(real: Json, fixture: Json, keys: string[], label: string): void {
	for (const k of keys) {
		expect(fixture, `${label}: missing key '${k}'`).toHaveProperty(k);
		expect(typeof fixture[k], `${label}: key '${k}' type drifted`).toBe(typeof real[k]);
	}
}

const find = (events: Json[], type: string, pred: (d: Json) => boolean = () => true): Json | undefined =>
	events.find((e) => e.type === type && pred(e));

let crasher: Json[];
let spender: Json[];
let fakepi: Json[];
let approver: Json[];

beforeAll(async () => {
	[crasher, spender, fakepi, approver] = await Promise.all([
		collectFixture("fake-pi-crasher.mjs"),
		collectFixture("fake-pi-spender.mjs"),
		collectFixture("fake-pi.mjs"),
		collectFixture("fake-pi-approver.mjs"),
	]);
}, 15000);

describe("fixture-drift guard: fakes must mirror the real captures", () => {
	it("tool_execution_end.result is the real OBJECT shape, not a bare string (the original drift class)", () => {
		const real = realData("s2-tool-call.jsonl", "tool_execution_end", (d) => at(d, "isError") === true);
		const fake = find(crasher, "tool_execution_end");
		expect(fake, "fake-pi-crasher emitted no tool_execution_end").toBeTruthy();
		// result must be an object with content+details (real pi), never a string.
		expect(typeof real.result).toBe("object");
		expect(typeof obj(fake).result, "result drifted from object → string").toBe("object");
		expect(real.result).toHaveProperty("content");
		expect(obj(obj(fake).result)).toHaveProperty("content");
		expect(obj(obj(fake).result)).toHaveProperty("details");
		expect(typeof obj(fake).isError).toBe("boolean");
		expect(typeof obj(fake).toolName).toBe("string");
	});

	it("assistant message_end.usage carries the real token+cost shape (the governor's read path)", () => {
		const realUsage = obj(
			at(
				realData("s1-basic-turn.jsonl", "message_end", (d) => at(d, "message", "role") === "assistant"),
				"message",
				"usage",
			),
		);
		for (const [label, events] of [
			["fake-pi-spender", spender],
			["fake-pi", fakepi],
		] as const) {
			const fake = find(events, "message_end", (d) => at(d, "message", "role") === "assistant");
			expect(fake, `${label} emitted no assistant message_end`).toBeTruthy();
			const fakeUsage = obj(at(fake, "message", "usage"));
			// extractUsage reads these four components + cost.total — all must be numeric, as in real pi.
			sameShape(realUsage, fakeUsage, ["input", "output", "cacheRead", "cacheWrite"], `${label}.usage`);
			expect(typeof at(fakeUsage, "cost", "total"), `${label}.usage.cost.total`).toBe("number");
		}
	});

	it("extension_ui_request matches real pi's confirm shape (the approval router's input)", () => {
		const real = realData("s4-approval-confirm.jsonl", "extension_ui_request", (d) => at(d, "method") === "confirm");
		const fake = find(approver, "extension_ui_request");
		expect(fake, "fake-pi-approver emitted no extension_ui_request").toBeTruthy();
		sameShape(real, obj(fake), ["id", "method", "title", "message"], "extension_ui_request");
		expect(obj(fake).method).toBe("confirm");
	});
});
