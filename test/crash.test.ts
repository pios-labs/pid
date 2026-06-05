import { beforeEach, describe, expect, it } from "vitest";
import { type CrashActions, CrashDetector, deriveSignature, type QuarantineConfig } from "../src/governor/crash.js";

const T0 = Date.parse("2026-06-01T10:00:00Z");

// --- event fixtures, shaped exactly as pi emits them (verified @ e56521e3, ADR 0003) ---

function toolEnd(toolName: string, isError: boolean): unknown {
	return { type: "tool_execution_end", toolCallId: "tc1", toolName, result: "...", isError };
}

function extensionError(extensionPath: string, event: string): unknown {
	return { type: "extension_error", extensionPath, event, error: "boom" };
}

function agentEnd(stopReason: string | null, willRetry: boolean): unknown {
	const messages: unknown[] = [{ role: "user", content: "hi" }];
	if (stopReason !== null) messages.push({ role: "assistant", stopReason, content: "..." });
	return { type: "agent_end", messages, willRetry };
}

// Capturing quarantine action + fixed clock.
function harness(now: () => number = () => T0) {
	const quarantined: string[] = [];
	const logged: Array<{ name: string; data: Record<string, unknown> }> = [];
	const actions: CrashActions = {
		quarantine: async (n: string) => {
			quarantined.push(n);
		},
		logQuarantine: (name: string, data: Record<string, unknown>) => {
			logged.push({ name, data });
		},
	};
	return { quarantined, logged, actions, now };
}

const config: QuarantineConfig = { same_failure_threshold: 3, window_seconds: 300 };

describe("deriveSignature", () => {
	it("names a failed tool by tool, coarsely (no exit code available)", () => {
		expect(deriveSignature(toolEnd("bash", true))).toBe("tool:bash:error");
	});

	it("ignores a successful tool", () => {
		expect(deriveSignature(toolEnd("bash", false))).toBeNull();
	});

	it("names an extension error by path and event", () => {
		expect(deriveSignature(extensionError("/ext/foo.ts", "agent_end"))).toBe("ext:/ext/foo.ts:agent_end");
	});

	it("counts agent_end only when pi gave up (willRetry false) on a genuine error", () => {
		expect(deriveSignature(agentEnd("error", false))).toBe("agent:error");
	});

	it("ignores agent_end while pi is still auto-retrying (willRetry true)", () => {
		// The core guard against premature quarantine from pi's internal transient retries.
		expect(deriveSignature(agentEnd("error", true))).toBeNull();
	});

	it("ignores agent_end aborted — that is pid's own pause/stop, not a crash", () => {
		// stopReason "aborted" is distinct from "error"; pid's pause/stop must never self-count.
		expect(deriveSignature(agentEnd("aborted", false))).toBeNull();
	});

	it("ignores agent_end with a non-error stopReason (normal end_turn / length)", () => {
		expect(deriveSignature(agentEnd("stop", false))).toBeNull();
		expect(deriveSignature(agentEnd("length", false))).toBeNull();
	});

	it("ignores agent_end with no assistant message", () => {
		expect(deriveSignature(agentEnd(null, false))).toBeNull();
	});

	it("ignores unrelated and malformed events (pid consumes an external stream)", () => {
		expect(deriveSignature({ type: "message_end" })).toBeNull();
		expect(deriveSignature({ type: "tool_execution_start", toolName: "bash" })).toBeNull();
		expect(deriveSignature(null)).toBeNull();
		expect(deriveSignature("garbage")).toBeNull();
		expect(deriveSignature({})).toBeNull();
	});

	it("falls back to 'unknown' on missing fields rather than throwing", () => {
		expect(deriveSignature({ type: "tool_execution_end", isError: true })).toBe("tool:unknown:error");
		expect(deriveSignature({ type: "extension_error" })).toBe("ext:unknown:unknown");
	});
});

describe("CrashDetector", () => {
	let h: ReturnType<typeof harness>;
	let det: CrashDetector;

	beforeEach(() => {
		h = harness();
		det = new CrashDetector({ actions: h.actions, now: h.now });
		det.register("svc", config);
	});

	it("quarantines at the threshold, not before", async () => {
		await det.handleEvent("svc", toolEnd("bash", true));
		await det.handleEvent("svc", toolEnd("bash", true));
		expect(h.quarantined).toEqual([]);
		expect(det.status("svc")?.quarantined).toBe(false);

		await det.handleEvent("svc", toolEnd("bash", true));
		expect(h.quarantined).toEqual(["svc"]);
		expect(det.status("svc")?.quarantined).toBe(true);
	});

	it("emits one pid_quarantine event (the documented contract) before quarantining", async () => {
		for (let i = 0; i < 3; i++) await det.handleEvent("svc", toolEnd("bash", true));
		expect(h.logged).toEqual([
			{
				name: "svc",
				data: { signature: "tool:bash:error", count: 3, threshold: 3, windowSeconds: 300, by: "crash_detector" },
			},
		]);
		// Logged for the chronicle even though it does not re-fire on subsequent failures.
		await det.handleEvent("svc", toolEnd("bash", true));
		expect(h.logged).toHaveLength(1);
	});

	it("counts per-signature: three different failures do not trip", async () => {
		await det.handleEvent("svc", toolEnd("bash", true));
		await det.handleEvent("svc", toolEnd("grep", true));
		await det.handleEvent("svc", extensionError("/e.ts", "x"));
		expect(h.quarantined).toEqual([]);
	});

	it("does not re-fire quarantine once quarantined", async () => {
		for (let i = 0; i < 5; i++) await det.handleEvent("svc", toolEnd("bash", true));
		expect(h.quarantined).toEqual(["svc"]);
	});

	it("prunes failures outside the window so a slow drip never trips", async () => {
		let now = T0;
		const slow = new CrashDetector({ actions: h.actions, now: () => now });
		slow.register("svc", config); // window_seconds: 300
		await slow.handleEvent("svc", toolEnd("bash", true));
		now += 200_000; // +200s
		await slow.handleEvent("svc", toolEnd("bash", true));
		now += 200_000; // +400s from first — first is now outside the 300s window
		await slow.handleEvent("svc", toolEnd("bash", true));
		// Only the last two are within any 300s window → count 2 < 3.
		expect(h.quarantined).toEqual([]);
	});

	it("ignores events for unregistered services", async () => {
		await det.handleEvent("unknown", toolEnd("bash", true));
		expect(h.quarantined).toEqual([]);
		expect(det.status("unknown")).toBeUndefined();
	});

	it("clear() resets history and the quarantine flag (the unquarantine path)", async () => {
		for (let i = 0; i < 3; i++) await det.handleEvent("svc", toolEnd("bash", true));
		expect(det.status("svc")?.quarantined).toBe(true);

		det.clear("svc");
		expect(det.status("svc")).toEqual({ quarantined: false, lastFailure: null });

		// After clearing, the count starts from zero again.
		await det.handleEvent("svc", toolEnd("bash", true));
		await det.handleEvent("svc", toolEnd("bash", true));
		expect(h.quarantined).toEqual(["svc"]); // still only the first quarantine
	});

	it("surfaces the most recent failure on status", async () => {
		await det.handleEvent("svc", toolEnd("bash", true));
		const status = det.status("svc");
		expect(status?.lastFailure?.signature).toBe("tool:bash:error");
		expect(status?.lastFailure?.at).toBe(new Date(T0).toISOString());
	});
});
