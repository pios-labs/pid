import { describe, expect, it } from "vitest";
import { formatLogLine, logDay } from "../src/log/render.js";
import type { LogEnvelope } from "../src/util/log.js";

const env = (type: string, data: unknown, source: "pi" | "pid" = "pi"): LogEnvelope => ({
	v: 1,
	ts: "2026-06-05T14:32:01.000Z",
	service: "nightly-tests",
	source,
	type,
	data,
});

describe("formatLogLine", () => {
	it("shows the time, the tool name as label, and the bash command as summary", () => {
		const s = formatLogLine(env("tool_execution_start", { toolName: "bash", args: { command: "ls ~/inbox" } }));
		expect(s).toMatch(/^14:32:01 {2}bash {2,}ls ~\/inbox$/);
	});

	it("renders a tool result status", () => {
		expect(formatLogLine(env("tool_execution_end", { toolName: "bash", isError: true }))).toContain("→ error");
		expect(formatLogLine(env("tool_execution_end", { toolName: "bash", isError: false }))).toContain("→ ok");
	});

	it("renders a message cost", () => {
		const s = formatLogLine(env("message_end", { message: { usage: { cost: { total: 0.034 } } } }));
		expect(s).toContain("message_end");
		expect(s).toContain("$0.03");
	});

	it("renders pid intervention summaries", () => {
		const pause = formatLogLine(
			env(
				"pid_budget_pause",
				{ breached: [{ cap: "daily_usd", limit: 10, spent: 10.4 }], resumeAt: "2026-06-06T00:00:00.000Z" },
				"pid",
			),
		);
		expect(pause).toContain("pid_budget_pause");
		expect(pause).toContain("daily_usd 10.4/10");
		expect(pause).toContain("resume 00:00");

		expect(
			formatLogLine(env("pid_approval", { phase: "resolve", decision: "deny", command: "rm -rf x" }, "pid")),
		).toContain("resolve  deny  rm -rf x");
	});

	it("optionally prefixes the service name (the tail multiplex)", () => {
		const s = formatLogLine(env("agent_start", {}), { withService: true, serviceWidth: 14 });
		expect(s.startsWith("nightly-tests")).toBe(true);
		expect(s).toContain("14:32:01");
	});

	it("degrades to just the label on an unexpected shape, never throws", () => {
		expect(formatLogLine(env("tool_execution_start", null))).toContain("tool");
		expect(formatLogLine(env("some_future_event", { weird: true }))).toContain("some_future_event");
	});
});

describe("logDay", () => {
	it("extracts the YYYY-MM-DD", () => {
		expect(logDay(env("agent_start", {}))).toBe("2026-06-05");
	});
});
