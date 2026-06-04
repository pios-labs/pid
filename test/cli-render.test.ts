import { describe, expect, it } from "vitest";
import type { PendingApproval } from "../src/approvals/router.js";
import { formatApprovalsTable, formatApproveReceipt, formatDenyReceipt } from "../src/cli-render.js";

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
