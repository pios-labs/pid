import { describe, expect, it } from "vitest";
import { serviceSchema } from "../src/services/schema.js";

// ADR 0014: triggers are `manual` (long-running) or `file_watch` (one-shot job on a file event). Native
// `cron` is delegated to the OS (`pid run` from system cron), so a `cron` trigger must be REJECTED at
// load — loud, not a silent no-op (the failure class the pre-launch audit caught). These pin that.

const base = { name: "svc", prompt: "hi" };

describe("trigger schema (ADR 0014)", () => {
	it("accepts manual (the long-running default)", () => {
		expect(serviceSchema.parse({ ...base }).trigger).toEqual({ type: "manual" });
		expect(serviceSchema.parse({ ...base, trigger: { type: "manual" } }).trigger.type).toBe("manual");
	});

	it("accepts file_watch with a path (events default to [add])", () => {
		const cfg = serviceSchema.parse({ ...base, trigger: { type: "file_watch", path: "~/inbox" } });
		expect(cfg.trigger).toEqual({ type: "file_watch", path: "~/inbox", events: ["add"] });
	});

	it("REJECTS cron loudly — pid does not reinvent the OS scheduler", () => {
		expect(() => serviceSchema.parse({ ...base, trigger: { type: "cron", schedule: "0 9 * * *" } })).toThrow();
	});
});
