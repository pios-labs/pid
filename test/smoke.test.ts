import { describe, expect, it } from "vitest";
import { serviceSchema } from "../src/services/schema.js";

describe("service schema", () => {
	it("accepts a minimal service definition", () => {
		const parsed = serviceSchema.parse({ name: "minimal" });
		expect(parsed.name).toBe("minimal");
		expect(parsed.command).toBe("pi");
		expect(parsed.args).toEqual(["--mode", "rpc", "--no-session"]);
		expect(parsed.trigger).toEqual({ type: "manual" });
		expect(parsed.restart.policy).toBe("on-failure");
	});

	it("validates a fuller service definition", () => {
		const parsed = serviceSchema.parse({
			name: "inbox-watcher",
			cwd: "~/inbox",
			prompt: "Check ~/inbox/ for new files",
			trigger: { type: "file_watch", path: "~/inbox/", events: ["add"] },
			budget: { daily_usd: 2.0, on_exceed: "pause" },
			gate: ["bash:rm", "bash:git-push"],
		});
		expect(parsed.budget?.daily_usd).toBe(2);
		expect(parsed.gate).toContain("bash:rm");
	});

	it("rejects bad names", () => {
		expect(() => serviceSchema.parse({ name: "Bad_Name" })).toThrow();
		expect(() => serviceSchema.parse({ name: "" })).toThrow();
	});
});
