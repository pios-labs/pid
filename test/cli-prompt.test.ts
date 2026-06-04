import { describe, expect, it } from "vitest";
import type { PendingApproval } from "../src/approvals/router.js";
import { resolveApprovalId } from "../src/cli-prompt.js";

/** Minimal PendingApproval carrying just an id (resolution only looks at ids). */
function entry(id: string): PendingApproval {
	return {
		id,
		service: "svc",
		method: "confirm",
		receivedAt: new Date(0).toISOString(),
		request: {},
	} as PendingApproval;
}

describe("resolveApprovalId", () => {
	const inbox = [entry("7f3a9c21-aaaa"), entry("7f3a9c99-bbbb"), entry("c0ffee00-cccc")];

	it("resolves a unique prefix", () => {
		expect(resolveApprovalId("c0ff", inbox).id).toBe("c0ffee00-cccc");
	});

	it("prefers an exact id even when it is a prefix of another", () => {
		const withExact = [entry("7f3a"), entry("7f3a9c21")];
		expect(resolveApprovalId("7f3a", withExact).id).toBe("7f3a");
	});

	it("throws on no match", () => {
		expect(() => resolveApprovalId("nope", inbox)).toThrow(/no pending approval matching 'nope'/);
	});

	it("throws on an ambiguous prefix, listing the candidates", () => {
		expect(() => resolveApprovalId("7f3a", inbox)).toThrow(/ambiguous id '7f3a' matches 2: 7f3a9c21, 7f3a9c99/);
	});
});
