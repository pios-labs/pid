import { Readable } from "node:stream";
import { describe, expect, it } from "vitest";
import { attachJsonlReader, serializeJsonLine } from "../src/util/jsonl.js";

describe("serializeJsonLine", () => {
	it("appends exactly one trailing newline", () => {
		expect(serializeJsonLine({ a: 1 })).toBe('{"a":1}\n');
		expect(serializeJsonLine("hi")).toBe('"hi"\n');
	});

	it("escapes newlines inside string values so they cannot inject a false line break", () => {
		const line = serializeJsonLine({ msg: "a\nb" });
		expect(line).toBe('{"msg":"a\\nb"}\n');
		// Exactly one real newline (the frame terminator), at the very end.
		expect(line.split("\n")).toHaveLength(2);
		expect(line.endsWith("\n")).toBe(true);
	});

	it("leaves U+2028 / U+2029 literal (valid in JSON strings; framing is LF-only)", () => {
		const sep = `${String.fromCharCode(0x2028)}${String.fromCharCode(0x2029)}`;
		const framed = serializeJsonLine({ s: `x${sep}y` });
		expect(framed).toContain(sep); // not escaped away by JSON.stringify
		expect(framed.split("\n")).toHaveLength(2); // and it did not split the frame
	});
});

describe("serializeJsonLine <-> attachJsonlReader round-trip", () => {
	it("recovers framed values, including embedded line/Unicode separators", async () => {
		const sep = String.fromCharCode(0x2028);
		const values = [{ type: "extension_ui_response", id: "req_1", confirmed: true }, { s: `a\nb${sep}c` }, 42];
		const stream = Readable.from([values.map(serializeJsonLine).join("")]);

		const seen: unknown[] = [];
		attachJsonlReader(stream, (v) => seen.push(v));
		await new Promise((r) => stream.on("end", r));

		expect(seen).toEqual(values);
	});
});
