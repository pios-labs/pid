import { describe, expect, it, vi } from "vitest";
import { type ApprovalPolicy, ApprovalRouter } from "../src/approvals/router.js";

function makeRouter(now: () => number = () => 0) {
	const sends: { name: string; message: Record<string, unknown> }[] = [];
	const logs: { name: string; data: Record<string, unknown> }[] = [];
	const actions = {
		send: async (name: string, message: unknown) => {
			sends.push({ name, message: message as Record<string, unknown> });
		},
		logApproval: (name: string, data: Record<string, unknown>) => {
			logs.push({ name, data });
		},
	};
	return { router: new ApprovalRouter({ actions, now }), sends, logs };
}

const TRUSTING: ApprovalPolicy = { gate: [], autoApprove: [], onUnmatched: "approve" };
const GATE_RM: ApprovalPolicy = { gate: ["bash:rm"], autoApprove: [], onUnmatched: "approve" };

const start = (toolCallId: string, command: string, toolName = "bash") => ({
	type: "tool_execution_start",
	toolCallId,
	toolName,
	args: { command },
});
const end = (toolCallId: string) => ({ type: "tool_execution_end", toolCallId, toolName: "bash" });
const confirm = (id: string, opts: Record<string, unknown> = {}) => ({
	type: "extension_ui_request",
	id,
	method: "confirm",
	message: "?",
	...opts,
});

describe("ApprovalRouter — correlation + decide", () => {
	it("auto-approves a confirm correlated to an in-flight tool that policy approves", () => {
		const { router, sends, logs } = makeRouter();
		router.register("svc", TRUSTING);
		router.handleEvent("svc", start("tc1", "ls -la"));
		router.handleEvent("svc", confirm("r1"));

		expect(sends).toEqual([{ name: "svc", message: { type: "extension_ui_response", id: "r1", confirmed: true } }]);
		expect(router.list()).toHaveLength(0);
		expect(logs.at(-1)?.data).toMatchObject({
			phase: "resolve",
			decision: "auto_approve",
			by: "policy",
			command: "ls -la",
		});
	});

	it("enqueues a gated confirm without replying", () => {
		const { router, sends, logs } = makeRouter();
		router.register("svc", GATE_RM);
		router.handleEvent("svc", start("tc1", "rm -rf x"));
		router.handleEvent("svc", confirm("r1"));

		expect(sends).toHaveLength(0);
		expect(router.list()).toHaveLength(1);
		expect(router.list()[0]).toMatchObject({ id: "r1", service: "svc", command: "rm -rf x" });
		expect(logs.at(-1)?.data).toMatchObject({ phase: "enqueue", verdict: "enqueue", command: "rm -rf x" });
	});

	it("correlates to the most-recently-started tool under parallelism", () => {
		const { router, sends } = makeRouter();
		router.register("svc", GATE_RM);
		// npm test starts and is auto-approved; rm then starts (both in-flight) and its confirm is gated.
		router.handleEvent("svc", start("tc1", "npm test"));
		router.handleEvent("svc", confirm("r1"));
		router.handleEvent("svc", start("tc2", "rm -rf dist"));
		router.handleEvent("svc", confirm("r2"));

		expect(sends).toEqual([{ name: "svc", message: { type: "extension_ui_response", id: "r1", confirmed: true } }]);
		expect(router.list()).toHaveLength(1);
		expect(router.list()[0]).toMatchObject({ id: "r2", command: "rm -rf dist" });
	});

	it("drops a tool from in-flight on tool_execution_end (so its later confirm is free-standing)", () => {
		const { router } = makeRouter();
		router.register("svc", GATE_RM);
		router.handleEvent("svc", start("tc1", "rm -rf x"));
		router.handleEvent("svc", end("tc1"));
		router.handleEvent("svc", confirm("r1"));

		// no in-flight tool -> free-standing -> enqueue with no correlated command
		expect(router.list()).toHaveLength(1);
		expect(router.list()[0]?.command).toBeUndefined();
	});

	it("a free-standing confirm (no in-flight tool) enqueues", () => {
		const { router, sends } = makeRouter();
		router.register("svc", TRUSTING);
		router.handleEvent("svc", confirm("r1"));
		expect(sends).toHaveLength(0);
		expect(router.list()).toHaveLength(1);
	});

	it("select/input/editor always enqueue, even when policy would approve", () => {
		const { router, sends } = makeRouter();
		router.register("svc", TRUSTING);
		router.handleEvent("svc", start("tc1", "ls"));
		router.handleEvent("svc", { type: "extension_ui_request", id: "r1", method: "select", options: ["a", "b"] });
		expect(sends).toHaveLength(0);
		expect(router.list()).toHaveLength(1);
		expect(router.list()[0]).toMatchObject({ method: "select" });
	});

	it("ignores fire-and-forget methods (no reply, no enqueue, no log)", () => {
		const { router, sends, logs } = makeRouter();
		router.register("svc", TRUSTING);
		router.handleEvent("svc", { type: "extension_ui_request", id: "r1", method: "notify", message: "hi" });
		expect(sends).toHaveLength(0);
		expect(router.list()).toHaveLength(0);
		expect(logs).toHaveLength(0);
	});

	it("no-ops for an unregistered service", () => {
		const { router, sends } = makeRouter();
		router.handleEvent("ghost", start("tc1", "ls"));
		router.handleEvent("ghost", confirm("r1"));
		expect(sends).toHaveLength(0);
		expect(router.list()).toHaveLength(0);
	});
});

describe("ApprovalRouter — approve / deny", () => {
	it("approve replies confirmed:true, clears the inbox, and logs the decision", async () => {
		const { router, sends, logs } = makeRouter();
		router.register("svc", GATE_RM);
		router.handleEvent("svc", start("tc1", "rm -rf x"));
		router.handleEvent("svc", confirm("r1"));

		await router.approve("r1");
		expect(sends).toEqual([{ name: "svc", message: { type: "extension_ui_response", id: "r1", confirmed: true } }]);
		expect(router.list()).toHaveLength(0);
		expect(logs.at(-1)?.data).toMatchObject({ phase: "resolve", decision: "approve", by: "cli" });
	});

	it("deny replies confirmed:false for a confirm", async () => {
		const { router, sends } = makeRouter();
		router.register("svc", GATE_RM);
		router.handleEvent("svc", start("tc1", "rm -rf x"));
		router.handleEvent("svc", confirm("r1"));

		await router.deny("r1", "too risky");
		expect(sends).toEqual([{ name: "svc", message: { type: "extension_ui_response", id: "r1", confirmed: false } }]);
	});

	it("approve replies value for a select; deny replies cancelled", async () => {
		const { router, sends } = makeRouter();
		router.register("svc", TRUSTING);
		router.handleEvent("svc", { type: "extension_ui_request", id: "r1", method: "select", options: ["a", "b"] });
		router.handleEvent("svc", { type: "extension_ui_request", id: "r2", method: "input" });

		await router.approve("r1", "a");
		await router.deny("r2");
		expect(sends[0]?.message).toEqual({ type: "extension_ui_response", id: "r1", value: "a" });
		expect(sends[1]?.message).toEqual({ type: "extension_ui_response", id: "r2", cancelled: true });
	});

	it("throws when approving an unknown / already-resolved id", async () => {
		const { router } = makeRouter();
		router.register("svc", TRUSTING);
		await expect(router.approve("nope")).rejects.toThrow(/no pending approval/);
	});
});

describe("ApprovalRouter — timeouts", () => {
	it("expires the inbox entry on timeout and logs expired (no reply)", () => {
		vi.useFakeTimers();
		try {
			const { router, sends, logs } = makeRouter();
			router.register("svc", GATE_RM);
			router.handleEvent("svc", start("tc1", "rm -rf x"));
			router.handleEvent("svc", confirm("r1", { timeout: 1000 }));
			expect(router.list()).toHaveLength(1);

			vi.advanceTimersByTime(1000);
			expect(router.list()).toHaveLength(0);
			expect(sends).toHaveLength(0); // pi already auto-resolved; we don't chase it
			expect(logs.at(-1)?.data).toMatchObject({ phase: "resolve", decision: "expired", by: "timeout" });
		} finally {
			vi.useRealTimers();
		}
	});

	it("approving before the deadline cancels the timer (no double-resolve)", async () => {
		vi.useFakeTimers();
		try {
			const { router, logs } = makeRouter();
			router.register("svc", GATE_RM);
			router.handleEvent("svc", start("tc1", "rm -rf x"));
			router.handleEvent("svc", confirm("r1", { timeout: 1000 }));

			await router.approve("r1");
			vi.advanceTimersByTime(1000); // the now-cancelled timer must not fire

			const resolves = logs.filter((l) => l.data.phase === "resolve");
			expect(resolves).toHaveLength(1);
			expect(resolves[0]?.data.decision).toBe("approve");
		} finally {
			vi.useRealTimers();
		}
	});
});
