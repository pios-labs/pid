import { describe, expect, it } from "vitest";
import {
	buildPiArgs,
	KNOWN_PI_FLAGS,
	type KnownPiFlag,
	type ServiceConfig,
	serviceSchema,
	YAML_FLAG_CONFLICTS,
} from "../src/services/schema.js";

// Flat lookup: every flag form (canonical key + aliases) → its registry entry.
const flagForms = new Map<string, KnownPiFlag>();
for (const [canonical, entry] of Object.entries(KNOWN_PI_FLAGS)) {
	flagForms.set(canonical, entry);
	for (const alias of entry.aliases ?? []) {
		flagForms.set(alias, entry);
	}
}

const nativeEntries = Object.entries(KNOWN_PI_FLAGS).filter(([, entry]) => entry.disposition === "native");

// A representative config per native flag — enough to make buildPiArgs emit it.
const EMIT_SAMPLES: Record<string, Partial<ServiceConfig>> = {
	"--provider": { model: { provider: "anthropic" } },
	"--model": { model: { id: "claude-sonnet-4-5" } },
	"--thinking": { model: { thinking: "low" } },
	"--models": { model: { scoped: ["anthropic/*"] } },
	"--tools": { tools: ["read"] },
	"--no-tools": { tools: false },
	"--no-builtin-tools": { no_builtin_tools: true },
	"--extension": { extensions: ["./ext.ts"] },
	"--no-extensions": { extensions: false },
	"--skill": { skills: ["./skill/"] },
	"--no-skills": { skills: false },
	"--no-context-files": { context_files: false },
	"--system-prompt": { system_prompt: "x" },
	"--append-system-prompt": { append_system_prompt: "x" },
};

describe("flag coverage: registry ↔ YAML_FLAG_CONFLICTS", () => {
	it("every conflict flag is registered as native/injected with a matching field", () => {
		for (const { flag, field } of YAML_FLAG_CONFLICTS) {
			const entry = flagForms.get(flag);
			expect(entry, `"${flag}" is in YAML_FLAG_CONFLICTS but missing from KNOWN_PI_FLAGS`).toBeDefined();
			if (!entry) continue;
			if (field === "(implicit)") {
				expect(entry.disposition, `"${flag}" should be injected`).toBe("injected");
			} else {
				expect(entry.disposition, `"${flag}" should be native`).toBe("native");
				expect(entry.field, `"${flag}" field mismatch`).toBe(field);
			}
		}
	});

	it("every native/injected flag form is covered by YAML_FLAG_CONFLICTS", () => {
		const conflictFlags = new Set(YAML_FLAG_CONFLICTS.map((c) => c.flag));
		for (const [canonical, entry] of Object.entries(KNOWN_PI_FLAGS)) {
			if (entry.disposition !== "native" && entry.disposition !== "injected") continue;
			for (const form of [canonical, ...(entry.aliases ?? [])]) {
				expect(
					conflictFlags.has(form),
					`"${form}" is a ${entry.disposition} flag but not in YAML_FLAG_CONFLICTS — conflict detection would miss it`,
				).toBe(true);
			}
		}
	});
});

describe("flag coverage: registry ↔ serviceSchema", () => {
	const fieldPaths = new Set<string>(Object.keys(serviceSchema.shape));
	for (const key of Object.keys(serviceSchema.shape.model.unwrap().shape)) {
		fieldPaths.add(`model.${key}`);
	}

	it("every native flag maps to a field that exists in serviceSchema", () => {
		for (const [flag, entry] of nativeEntries) {
			expect(entry.field, `"${flag}" is native but has no field`).toBeDefined();
			if (!entry.field) continue;
			expect(fieldPaths.has(entry.field), `"${flag}" maps to field "${entry.field}" which is not in serviceSchema`).toBe(
				true,
			);
		}
	});
});

describe("flag coverage: registry ↔ buildPiArgs", () => {
	it("pid always injects --mode rpc and --session-id", () => {
		const args = buildPiArgs(serviceSchema.parse({ name: "x" }));
		expect(args).toContain("--mode");
		expect(args).toContain("rpc");
		expect(args).toContain("--session-id");
	});

	it("every native flag is emitted by buildPiArgs when its field is set", () => {
		for (const [flag, entry] of nativeEntries) {
			const sample = EMIT_SAMPLES[flag];
			expect(sample, `add an EMIT_SAMPLES entry for "${flag}"`).toBeDefined();
			if (!sample) continue;
			const args = buildPiArgs(serviceSchema.parse({ name: "flag-test", ...sample }));
			const forms = [flag, ...(entry.aliases ?? [])];
			expect(
				forms.some((f) => args.includes(f)),
				`setting field "${entry.field}" did not emit any of: ${forms.join(", ")}`,
			).toBe(true);
		}
	});
});
