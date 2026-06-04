import { describe, expect, it } from "vitest";
import type { PendingApproval } from "../src/approvals/router.js";
import {
	formatActionReceipt,
	formatApprovalsTable,
	formatApproveReceipt,
	formatDenyReceipt,
	formatStatus,
} from "../src/cli-render.js";
import type { ServiceConfig } from "../src/services/schema.js";
import type { ServiceStatus } from "../src/supervisor/index.js";

/** Build a ServiceStatus for rendering tests (startedAt fixed at epoch so uptime is deterministic). */
function svc(fields: Omit<Partial<ServiceStatus>, "config"> & { config?: Partial<ServiceConfig> }): ServiceStatus {
	const { config, ...rest } = fields;
	return {
		name: "svc",
		state: "running",
		pendingApprovals: 0,
		...rest,
		config: { command: "pi", ...config } as ServiceConfig,
	} as ServiceStatus;
}

/** Build a PendingApproval for rendering tests (receivedAt fixed at epoch so age is deterministic). */
function pending(fields: Partial<PendingApproval> & { request?: Record<string, unknown> }): PendingApproval {
	const base = {
		id: "abc",
		service: "svc",
		method: "confirm",
		receivedAt: new Date(0).toISOString(),
		request: { type: "extension_ui_request", id: "abc", method: "confirm", title: "Proceed?" },
	};
	return { ...base, ...fields } as PendingApproval;
}

describe("formatApprovalsTable", () => {
	it("renders an empty note when nothing is pending", () => {
		expect(formatApprovalsTable([], 0)).toBe("No pending approvals.");
	});

	it("renders headers, a row, derived age, and the prompt title", () => {
		const now = 3 * 60 * 1000; // 3 minutes after receivedAt(epoch)
		const out = formatApprovalsTable(
			[
				pending({
					id: "7f3a9c21",
					service: "release-captain",
					method: "select",
					request: {
						type: "extension_ui_request",
						id: "7f3a9c21",
						method: "select",
						title: "Deploy target?",
						options: ["staging", "prod"],
					},
				}),
			],
			now,
		);
		for (const part of [
			"ID",
			"SERVICE",
			"METHOD",
			"AGE",
			"PROMPT",
			"7f3a9c21",
			"release-captain",
			"select",
			"3m",
			"Deploy target?",
		]) {
			expect(out).toContain(part);
		}
	});
});

describe("approve / deny receipts", () => {
	it("a confirm receipt carries no value note", () => {
		expect(formatApproveReceipt(pending({ method: "confirm" }))).toBe("✓ approved abc → svc");
	});

	it("a non-confirm receipt shows the supplied value", () => {
		expect(formatApproveReceipt(pending({ id: "7f3a", method: "select" }), "staging")).toBe(
			"✓ approved 7f3a → svc  (value: staging)",
		);
	});

	it("a long value is summarised by length, not dumped", () => {
		expect(formatApproveReceipt(pending({ method: "editor" }), "x".repeat(50))).toContain("(value: 50 chars)");
	});

	it("a deny receipt names the request and service", () => {
		expect(formatDenyReceipt(pending({ id: "7f3a" }))).toBe("✓ denied 7f3a → svc");
	});
});

describe("formatStatus — overview table", () => {
	it("renders an empty note when there are no services", () => {
		expect(formatStatus([], 0)).toBe("No services.");
	});

	it("renders headers, a running row (pid + age + pending) and a held row with dashes", () => {
		const now = 2 * 60 * 60 * 1000; // 2h after epoch
		const out = formatStatus(
			[
				svc({
					name: "release-captain",
					state: "running",
					pid: 48213,
					startedAt: new Date(0).toISOString(),
					pendingApprovals: 1,
				}),
				svc({ name: "docs-bot", state: "quarantined", pendingApprovals: 0 }),
			],
			now,
		);
		for (const part of [
			"NAME",
			"STATE",
			"PID",
			"UPTIME",
			"PENDING",
			"release-captain",
			"running",
			"48213",
			"2h",
			"docs-bot",
			"quarantined",
		]) {
			expect(out).toContain(part);
		}
		// A not-running service shows dashes for pid/uptime, never a stale value.
		expect(out).toMatch(/^docs-bot\s+quarantined\s+-\s+-\s+0$/m);
		expect(out).toContain("2 services");
	});

	it("singularises the footer for one service", () => {
		expect(formatStatus([svc({ name: "only" })], 0)).toContain("1 service");
	});
});

describe("formatStatus — single-service detail block", () => {
	it("renders a running service with uptime, the curated model line, and pending count", () => {
		const out = formatStatus(
			svc({
				name: "release-captain",
				state: "running",
				pid: 48213,
				startedAt: new Date(0).toISOString(),
				pendingApprovals: 1,
				config: { command: "pi", model: { provider: "anthropic", id: "claude-opus-4-8" } },
			}),
			60 * 60 * 1000, // 1h after epoch
		);
		expect(out).toContain("release-captain");
		expect(out).toContain("state    running");
		expect(out).toContain("pid      48213");
		expect(out).toContain("uptime   1h  (since 1970-01-01 00:00 UTC)");
		expect(out).toContain("command  pi  (model: anthropic/claude-opus-4-8)");
		expect(out).toContain("pending  1 approval");
		expect(out).not.toContain("why"); // no failure recorded
	});

	it("shows a crash-loop why line for a quarantined service and omits pid/uptime", () => {
		const out = formatStatus(
			svc({
				name: "docs-bot",
				state: "quarantined",
				lastFailure: { at: new Date(0).toISOString(), signature: "tool:bash:error" },
			}),
			0,
		);
		expect(out).toContain("pending  0 approvals");
		expect(out).toContain("why      crash loop: tool:bash:error  (1970-01-01 00:00 UTC)");
		expect(out).not.toContain("pid ");
		expect(out).not.toContain("uptime");
	});

	it("a paused service shows no why line (paused signals budget; no governor join)", () => {
		const out = formatStatus(svc({ name: "nightly-tests", state: "paused" }), 0);
		expect(out).toContain("state    paused");
		expect(out).not.toContain("why");
	});
});

describe("formatActionReceipt", () => {
	it("includes the landed state with an arrow when given one", () => {
		expect(formatActionReceipt("started", "release-captain", "running")).toBe("✓ started release-captain → running");
	});

	it("omits the arrow for stateless toggles", () => {
		expect(formatActionReceipt("enabled", "release-captain")).toBe("✓ enabled release-captain");
	});
});
