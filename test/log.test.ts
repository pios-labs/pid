import { describe, expect, it } from "vitest";
import { formatPidEvent, formatPiEvent, LOG_SCHEMA_VERSION, persistsToChronicle } from "../src/util/log.js";

const TS = "2026-06-03T03:00:00.000Z";

describe("log envelope", () => {
	it("wraps a pi event verbatim under data, deriving type from the event", () => {
		const ev = { type: "tool_execution_start", toolCallId: "tc_1", toolName: "bash", args: { command: "ls" } };
		const parsed = JSON.parse(formatPiEvent("svc", ev, TS));
		expect(parsed).toEqual({
			v: LOG_SCHEMA_VERSION,
			ts: TS,
			service: "svc",
			source: "pi",
			type: "tool_execution_start",
			data: ev,
		});
		expect(parsed.data).toEqual(ev); // pi's fields untouched
	});

	it("falls back to type 'unknown' for a non-object or typeless pi line", () => {
		expect(JSON.parse(formatPiEvent("svc", 42, TS)).type).toBe("unknown");
		expect(JSON.parse(formatPiEvent("svc", { foo: 1 }, TS)).type).toBe("unknown");
	});

	it("wraps a pid synthetic event with source 'pid'", () => {
		const parsed = JSON.parse(
			formatPidEvent("svc", "pid_approval", { id: "req_1", phase: "resolve", decision: "deny" }, TS),
		);
		expect(parsed).toEqual({
			v: LOG_SCHEMA_VERSION,
			ts: TS,
			service: "svc",
			source: "pid",
			type: "pid_approval",
			data: { id: "req_1", phase: "resolve", decision: "deny" },
		});
	});

	it("emits exactly one trailing newline (LF framing)", () => {
		const line = formatPidEvent("svc", "pid_parse_error", { error: "x", raw: "y" }, TS);
		expect(line.endsWith("\n")).toBe(true);
		expect(line.slice(0, -1).includes("\n")).toBe(false);
	});
});

describe("persistsToChronicle (ADR 0009)", () => {
	it("drops the high-frequency streaming frames", () => {
		expect(persistsToChronicle({ type: "message_update" })).toBe(false);
		expect(persistsToChronicle({ type: "tool_execution_update" })).toBe(false);
	});

	it("keeps every lifecycle event (and the terminal forms that carry final content)", () => {
		for (const type of [
			"agent_start",
			"turn_start",
			"message_start",
			"message_end",
			"tool_execution_start",
			"tool_execution_end",
			"extension_ui_request",
			"extension_error",
		]) {
			expect(persistsToChronicle({ type })).toBe(true);
		}
	});

	it("keeps anything unrecognised — only known noise is suppressed", () => {
		expect(persistsToChronicle({ type: "some_future_event" })).toBe(true);
		expect(persistsToChronicle({ noType: 1 })).toBe(true);
		expect(persistsToChronicle(42)).toBe(true);
	});
});
