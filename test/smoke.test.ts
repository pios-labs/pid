import { describe, expect, it } from "vitest";
import { buildPiArgs, serviceSchema, validateNoConflicts } from "../src/services/schema.js";

describe("service schema", () => {
	it("accepts a minimal service definition", () => {
		const parsed = serviceSchema.parse({ name: "minimal" });
		expect(parsed.name).toBe("minimal");
		expect(parsed.command).toBe("pi");
		expect(parsed.args).toEqual([]);
		expect(parsed.trigger).toEqual({ type: "manual" });
		expect(parsed.restart.policy).toBe("on-failure");
	});

	it("validates a fuller service definition", () => {
		const parsed = serviceSchema.parse({
			name: "inbox-watcher",
			cwd: "~/inbox",
			prompt: "Check ~/inbox/ for new files",
			model: { provider: "zai", id: "glm-5.1", thinking: "medium" },
			tools: ["read", "grep", "find", "ls"],
			trigger: { type: "file_watch", path: "~/inbox/", events: ["add"] },
			budget: { daily_usd: 2.0, on_exceed: "pause" },
			gate: ["bash:rm", "bash:git push"],
		});
		expect(parsed.budget?.daily_usd).toBe(2);
		expect(parsed.gate).toContain("bash:rm");
		expect(parsed.model?.provider).toBe("zai");
		expect(parsed.tools).toEqual(["read", "grep", "find", "ls"]);
	});

	it("accepts pi configuration fields", () => {
		const parsed = serviceSchema.parse({
			name: "full-pi-config",
			model: { provider: "anthropic", id: "claude-sonnet-4-5", thinking: "high", scoped: ["claude-*"] },
			tools: ["read", "grep", "find", "ls", "fetch_url"],
			extensions: ["./my-ext.ts", "./other-ext.ts"],
			skills: ["./my-skill/"],
			context_files: false,
			system_prompt: "You are a code reviewer.",
			append_system_prompt: "Be concise.",
		});
		expect(parsed.model?.thinking).toBe("high");
		expect(parsed.extensions).toEqual(["./my-ext.ts", "./other-ext.ts"]);
		expect(parsed.context_files).toBe(false);
		expect(parsed.system_prompt).toBe("You are a code reviewer.");
	});

	it("accepts no_builtin_tools", () => {
		const parsed = serviceSchema.parse({
			name: "ext-only",
			no_builtin_tools: true,
		});
		expect(parsed.no_builtin_tools).toBe(true);
	});

	it("accepts tools: false to disable all tools", () => {
		const parsed = serviceSchema.parse({
			name: "chat-only",
			tools: false,
		});
		expect(parsed.tools).toBe(false);
	});

	it("accepts extensions: false to skip discovery", () => {
		const parsed = serviceSchema.parse({
			name: "no-ext",
			extensions: false,
		});
		expect(parsed.extensions).toBe(false);
	});

	it("rejects bad names", () => {
		expect(() => serviceSchema.parse({ name: "Bad_Name" })).toThrow();
		expect(() => serviceSchema.parse({ name: "" })).toThrow();
	});

	it("rejects invalid thinking levels", () => {
		expect(() => serviceSchema.parse({ name: "bad-thinking", model: { thinking: "mega" } })).toThrow();
	});

	it("defaults on_unmatched to approve (the trusting/YOLO posture)", () => {
		expect(serviceSchema.parse({ name: "yolo" }).on_unmatched).toBe("approve");
		expect(serviceSchema.parse({ name: "cautious", on_unmatched: "ask" }).on_unmatched).toBe("ask");
	});

	it("rejects an approval descriptor whose bare token isn't a pi tool (the gate: [rm] typo)", () => {
		expect(() => serviceSchema.parse({ name: "typo", gate: ["rm"] })).toThrow(/bash:rm/);
		expect(() => serviceSchema.parse({ name: "nonbash", auto_approve: ["write:/etc"] })).toThrow();
	});
});

describe("budget config", () => {
	it("defaults on_exceed to pause and reset_tz to UTC", () => {
		const parsed = serviceSchema.parse({ name: "budgeted", budget: { daily_usd: 5 } });
		expect(parsed.budget?.on_exceed).toBe("pause");
		expect(parsed.budget?.reset_tz).toBe("UTC");
	});

	it("accepts notify and a valid IANA reset_tz", () => {
		const parsed = serviceSchema.parse({
			name: "observed",
			budget: { weekly_usd: 50, daily_tokens: 1_000_000, on_exceed: "notify", reset_tz: "Europe/London" },
		});
		expect(parsed.budget?.on_exceed).toBe("notify");
		expect(parsed.budget?.reset_tz).toBe("Europe/London");
		expect(parsed.budget?.daily_tokens).toBe(1_000_000);
	});

	it("rejects the deferred quarantine action (ADR 0002)", () => {
		expect(() => serviceSchema.parse({ name: "q", budget: { daily_usd: 5, on_exceed: "quarantine" } })).toThrow();
	});

	it("rejects an invalid reset_tz", () => {
		expect(() => serviceSchema.parse({ name: "badtz", budget: { daily_usd: 5, reset_tz: "Not/AZone" } })).toThrow();
	});
});

describe("conflict detection", () => {
	it("detects --tools in args when tools field is set", () => {
		const config = serviceSchema.parse({
			name: "conflict-tools",
			tools: ["read", "grep"],
			args: ["--tools", "read,grep"],
		});
		const errors = validateNoConflicts(config);
		expect(errors.length).toBeGreaterThan(0);
		expect(errors[0]).toContain("--tools");
		expect(errors[0]).toContain("Pick one");
	});

	it("detects --model in args when model.id is set", () => {
		const config = serviceSchema.parse({
			name: "conflict-model",
			model: { id: "glm-5.1" },
			args: ["--model", "gpt-5.4"],
		});
		const errors = validateNoConflicts(config);
		expect(errors.length).toBeGreaterThan(0);
		expect(errors[0]).toContain("--model");
	});

	it("detects --mode in args (always injected by pid)", () => {
		const config = serviceSchema.parse({
			name: "conflict-mode",
			args: ["--mode", "json"],
		});
		const errors = validateNoConflicts(config);
		expect(errors.length).toBeGreaterThan(0);
		expect(errors[0]).toContain("pid always injects");
	});

	it("detects --session-id in args (always injected by pid)", () => {
		const config = serviceSchema.parse({
			name: "conflict-session",
			args: ["--session-id", "my-custom-id"],
		});
		const errors = validateNoConflicts(config);
		expect(errors.length).toBeGreaterThan(0);
		expect(errors[0]).toContain("pid always injects");
	});

	it("detects tools and no_builtin_tools used together", () => {
		const config = serviceSchema.parse({
			name: "conflict-both-tools",
			tools: ["read"],
			no_builtin_tools: true,
		});
		const errors = validateNoConflicts(config);
		expect(errors.length).toBeGreaterThan(0);
		expect(errors[0]).toContain("mutually exclusive");
	});

	it("allows --tools in args when tools field is NOT set", () => {
		const config = serviceSchema.parse({
			name: "args-only-tools",
			args: ["--tools", "read,grep"],
		});
		const errors = validateNoConflicts(config);
		expect(errors).toEqual([]);
	});

	it("allows extra args that don't conflict", () => {
		const config = serviceSchema.parse({
			name: "extra-args",
			model: { provider: "zai", id: "glm-5.1" },
			args: ["--verbose"],
		});
		const errors = validateNoConflicts(config);
		expect(errors).toEqual([]);
	});
});

describe("buildPiArgs", () => {
	it("builds minimal args with just --mode and --session-id", () => {
		const config = serviceSchema.parse({ name: "minimal" });
		const args = buildPiArgs(config);
		expect(args).toEqual(["--mode", "rpc", "--session-id", "minimal"]);
	});

	it("builds args from model fields", () => {
		const config = serviceSchema.parse({
			name: "modelled",
			model: { provider: "zai", id: "glm-5.1", thinking: "high", scoped: ["zai/*", "anthropic/*"] },
		});
		const args = buildPiArgs(config);
		expect(args).toContain("--provider");
		expect(args).toContain("zai");
		expect(args).toContain("--model");
		expect(args).toContain("glm-5.1");
		expect(args).toContain("--thinking");
		expect(args).toContain("high");
		expect(args).toContain("--models");
		expect(args).toContain("zai/*,anthropic/*");
	});

	it("builds args from tools allowlist", () => {
		const config = serviceSchema.parse({
			name: "read-only",
			tools: ["read", "grep", "find", "ls"],
		});
		const args = buildPiArgs(config);
		expect(args).toContain("--tools");
		expect(args).toContain("read,grep,find,ls");
	});

	it("builds --no-tools from tools: false", () => {
		const config = serviceSchema.parse({
			name: "no-tools",
			tools: false,
		});
		const args = buildPiArgs(config);
		expect(args).toContain("--no-tools");
	});

	it("builds --no-builtin-tools", () => {
		const config = serviceSchema.parse({
			name: "ext-only",
			no_builtin_tools: true,
		});
		const args = buildPiArgs(config);
		expect(args).toContain("--no-builtin-tools");
	});

	it("builds args from extensions list", () => {
		const config = serviceSchema.parse({
			name: "with-exts",
			extensions: ["./ext1.ts", "./ext2.ts"],
		});
		const args = buildPiArgs(config);
		expect(args).toContain("--no-extensions");
		expect(args).toContain("-e");
		expect(args.indexOf("-e")).toBeLessThan(args.indexOf("./ext1.ts"));
	});

	it("builds --no-extensions from extensions: false", () => {
		const config = serviceSchema.parse({
			name: "no-exts",
			extensions: false,
		});
		const args = buildPiArgs(config);
		expect(args).toContain("--no-extensions");
		expect(args).not.toContain("-e");
	});

	it("builds --no-context-files", () => {
		const config = serviceSchema.parse({
			name: "no-ctx",
			context_files: false,
		});
		const args = buildPiArgs(config);
		expect(args).toContain("--no-context-files");
	});

	it("builds system prompt flags", () => {
		const config = serviceSchema.parse({
			name: "prompted",
			system_prompt: "You are a reviewer.",
			append_system_prompt: "Be concise.",
		});
		const args = buildPiArgs(config);
		expect(args).toContain("--system-prompt");
		expect(args).toContain("You are a reviewer.");
		expect(args).toContain("--append-system-prompt");
		expect(args).toContain("Be concise.");
	});

	it("appends user args after YAML-derived args", () => {
		const config = serviceSchema.parse({
			name: "with-extras",
			model: { provider: "zai", id: "glm-5.1" },
			args: ["--verbose"],
		});
		const args = buildPiArgs(config);
		const verboseIdx = args.indexOf("--verbose");
		const modelIdx = args.indexOf("--model");
		expect(verboseIdx).toBeGreaterThan(modelIdx);
	});

	it("builds a complete real-world service", () => {
		const config = serviceSchema.parse({
			name: "production-reviewer",
			model: { provider: "anthropic", id: "claude-sonnet-4-5", thinking: "high" },
			tools: ["read", "grep", "find", "ls"],
			extensions: ["./secret-scanner.ts"],
			context_files: false,
			append_system_prompt: "You are running unattended. Be conservative.",
		});
		const args = buildPiArgs(config);
		expect(args[0]).toBe("--mode");
		expect(args[1]).toBe("rpc");
		expect(args[2]).toBe("--session-id");
		expect(args[3]).toBe("production-reviewer");
		expect(args).toContain("--provider");
		expect(args).toContain("--tools");
		expect(args).toContain("--no-extensions");
		expect(args).toContain("-e");
		expect(args).toContain("--no-context-files");
		expect(args).toContain("--append-system-prompt");
	});
});
