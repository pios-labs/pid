import { z } from "zod";
import { parseDescriptor } from "../approvals/matcher.js";
import { isValidTimeZone } from "../util/time.js";

/**
 * An approval policy list (`gate` / `auto_approve`). Each entry must parse as a descriptor
 * (`<tool>` or `bash:<phrase>`, ADR 0004 §6); a bad entry — e.g. the `gate: [rm]` typo, where a
 * bare token must be a pi tool name — is rejected at load with the parser's own guidance.
 */
const descriptorListSchema = z
	.array(z.string())
	.default([])
	.superRefine((list, ctx) => {
		for (const raw of list) {
			try {
				parseDescriptor(raw);
			} catch (err) {
				ctx.addIssue({
					code: z.ZodIssueCode.custom,
					message: err instanceof Error ? err.message : String(err),
				});
			}
		}
	});

// Triggers are supervised jobs (ADR 0014): `manual` is the long-running model; `file_watch` runs a
// one-shot job on a filesystem event. Time-based scheduling is delegated to the OS — point system
// cron/launchd/systemd at `pid run <service>` — so pid does not reinvent cron. A `cron` trigger is
// therefore rejected here (loud, not a silent no-op) rather than accepted and never fired.
const triggerSchema = z.discriminatedUnion("type", [
	z.object({ type: z.literal("manual") }),
	z.object({
		type: z.literal("file_watch"),
		path: z.string(),
		events: z.array(z.enum(["add", "change", "unlink"])).default(["add"]),
	}),
]);

const budgetSchema = z.object({
	daily_usd: z.number().positive().optional(),
	weekly_usd: z.number().positive().optional(),
	daily_tokens: z.number().int().positive().optional(),
	// `quarantine` is deferred (it would co-own the quarantined state with the unbuilt
	// crash detector) — see ADR 0002. v0 enforces pause (default) and observe-only notify.
	on_exceed: z.enum(["pause", "notify"]).default("pause"),
	// Windows are calendar-aligned in this zone; reject typo'd zones at load (ADR 0002 / Q3).
	reset_tz: z
		.string()
		.default("UTC")
		.refine(isValidTimeZone, { message: "reset_tz must be a valid IANA time zone (e.g. UTC, Europe/London)" }),
});

const restartSchema = z.object({
	policy: z.enum(["always", "on-failure", "never"]).default("on-failure"),
	max_consecutive: z.number().int().positive().default(5),
	backoff: z
		.object({
			initial_ms: z.number().int().positive().default(1000),
			max_ms: z.number().int().positive().default(60_000),
			factor: z.number().positive().default(2),
		})
		.default({}),
});

const quarantineSchema = z.object({
	same_failure_threshold: z.number().int().positive().default(3),
	window_seconds: z.number().int().positive().default(300),
});

const modelSchema = z.object({
	provider: z.string().optional(),
	id: z.string().optional(),
	thinking: z.enum(["off", "minimal", "low", "medium", "high", "xhigh"]).optional(),
	scoped: z.array(z.string()).optional(),
});

const toolsSchema = z.union([z.array(z.string()).min(1), z.literal(false)]);

export const serviceSchema = z.object({
	name: z.string().regex(/^[a-z0-9][a-z0-9-]{0,62}$/, "name must be kebab-case"),
	command: z.string().default("pi"),
	args: z.array(z.string()).default([]),
	cwd: z.string().optional(),
	env: z.record(z.string()).default({}),
	prompt: z.string().optional(),

	// Pi configuration — maps to pi CLI flags.
	// pid always injects: --mode rpc --session-id <service-name>
	// These fields generate additional flags. Use args for anything not covered here.
	model: modelSchema.optional(),
	tools: toolsSchema.optional(),
	no_builtin_tools: z.boolean().optional(),
	extensions: z.union([z.array(z.string()).min(1), z.literal(false)]).optional(),
	skills: z.union([z.array(z.string()).min(1), z.literal(false)]).optional(),
	context_files: z.literal(false).optional(),
	system_prompt: z.string().optional(),
	append_system_prompt: z.string().optional(),

	// pid policy — supervision, cost, crash detection, approvals.
	trigger: triggerSchema.default({ type: "manual" }),
	budget: budgetSchema.optional(),
	restart: restartSchema.default({}),
	quarantine: quarantineSchema.default({}),
	gate: descriptorListSchema,
	auto_approve: descriptorListSchema,
	// Posture for a dialog matching neither list (ADR 0004 §1): `approve` = trusting/YOLO (the
	// default — a small `gate` block-list), `ask` = cautious (a small `auto_approve` allow-list).
	on_unmatched: z.enum(["approve", "ask"]).default("approve"),
});

export type ServiceConfig = z.infer<typeof serviceSchema>;

/**
 * Flags that have corresponding YAML fields. If any of these appear in the
 * args array while the YAML field is also set, the service is invalid.
 */
export const YAML_FLAG_CONFLICTS: { flag: string; field: string }[] = [
	{ flag: "--provider", field: "model.provider" },
	{ flag: "--model", field: "model.id" },
	{ flag: "--thinking", field: "model.thinking" },
	{ flag: "--models", field: "model.scoped" },
	{ flag: "--tools", field: "tools" },
	{ flag: "-t", field: "tools" },
	{ flag: "--no-tools", field: "tools" },
	{ flag: "-nt", field: "tools" },
	{ flag: "--no-builtin-tools", field: "no_builtin_tools" },
	{ flag: "-nbt", field: "no_builtin_tools" },
	{ flag: "--extension", field: "extensions" },
	{ flag: "-e", field: "extensions" },
	{ flag: "--no-extensions", field: "extensions" },
	{ flag: "-ne", field: "extensions" },
	{ flag: "--skill", field: "skills" },
	{ flag: "--no-skills", field: "skills" },
	{ flag: "-ns", field: "skills" },
	{ flag: "--no-context-files", field: "context_files" },
	{ flag: "-nc", field: "context_files" },
	{ flag: "--system-prompt", field: "system_prompt" },
	{ flag: "--append-system-prompt", field: "append_system_prompt" },
	{ flag: "--mode", field: "(implicit)" },
	{ flag: "--session-id", field: "(implicit)" },
];

/**
 * Disposition of a pi CLI flag with respect to pid's service file:
 * - `native`      — a validated YAML field emits the flag (see `buildPiArgs`).
 * - `injected`    — pid always sets it automatically (`--mode`, `--session-id`).
 * - `pid-managed` — pid owns this concern (session identity/resume); not user YAML.
 * - `catchall`    — reachable only via the `args` passthrough; a promotion candidate.
 * - `na`          — interactive/mode-only, irrelevant to a supervised RPC subprocess.
 */
export type FlagDisposition = "native" | "injected" | "pid-managed" | "catchall" | "na";

export interface KnownPiFlag {
	disposition: FlagDisposition;
	/** YAML field (dot-path) whose presence emits this flag. Required for `native`. */
	field?: string;
	/** Other flag forms pi accepts for the same option. */
	aliases?: string[];
	/** Rationale for non-native dispositions. */
	note?: string;
}

/**
 * Every RPC-relevant pi CLI flag and how pid exposes it — the in-code mirror of
 * the "Flag coverage" matrix in `pi-upstream-status.md`, keyed by canonical long
 * flag. `test/flag-coverage.test.ts` holds this consistent with `serviceSchema`,
 * `YAML_FLAG_CONFLICTS`, and `buildPiArgs`; the `/refresh-pi` command diffs
 * pi's `args.ts` against it to catch new upstream flags.
 *
 * Source of truth for pi's flag set: `pi/packages/coding-agent/src/cli/args.ts`.
 */
export const KNOWN_PI_FLAGS: Record<string, KnownPiFlag> = {
	// Native — a YAML field emits the flag.
	"--provider": { disposition: "native", field: "model.provider" },
	"--model": { disposition: "native", field: "model.id" },
	"--thinking": { disposition: "native", field: "model.thinking" },
	"--models": { disposition: "native", field: "model.scoped" },
	"--tools": { disposition: "native", field: "tools", aliases: ["-t"] },
	"--no-tools": { disposition: "native", field: "tools", aliases: ["-nt"] },
	"--no-builtin-tools": { disposition: "native", field: "no_builtin_tools", aliases: ["-nbt"] },
	"--extension": { disposition: "native", field: "extensions", aliases: ["-e"] },
	"--no-extensions": { disposition: "native", field: "extensions", aliases: ["-ne"] },
	"--skill": { disposition: "native", field: "skills" },
	"--no-skills": { disposition: "native", field: "skills", aliases: ["-ns"] },
	"--no-context-files": { disposition: "native", field: "context_files", aliases: ["-nc"] },
	"--system-prompt": { disposition: "native", field: "system_prompt" },
	"--append-system-prompt": { disposition: "native", field: "append_system_prompt" },

	// Injected — pid always sets these.
	"--mode": { disposition: "injected" },
	"--session-id": { disposition: "injected" },

	// pid-managed — pid owns session identity/resume; not user YAML.
	"--no-session": { disposition: "pid-managed", note: "pid controls session identity" },
	"--session": { disposition: "pid-managed", note: "pid controls session identity" },
	"--fork": { disposition: "pid-managed", note: "pid controls session lifecycle" },
	"--session-dir": { disposition: "pid-managed", note: "pid controls session storage" },
	"--continue": { disposition: "pid-managed", aliases: ["-c"], note: "pid controls resume" },
	"--resume": { disposition: "pid-managed", aliases: ["-r"], note: "pid controls resume" },

	// Catchall — reachable via `args`; promotion candidates (see action items in pi-upstream-status.md).
	"--exclude-tools": { disposition: "catchall", aliases: ["-xt"], note: "promote → A1" },
	"--name": { disposition: "catchall", aliases: ["-n"], note: "promote → A2" },
	"--prompt-template": { disposition: "catchall" },
	"--no-prompt-templates": { disposition: "catchall", aliases: ["-np"] },
	"--theme": { disposition: "catchall", note: "cosmetic; likely leave catchall" },
	"--no-themes": { disposition: "catchall", note: "cosmetic" },
	"--verbose": { disposition: "catchall" },
	"--offline": { disposition: "catchall" },
	"--api-key": { disposition: "catchall", note: "prefer service env:; do not put secrets in YAML" },
	"--export": { disposition: "catchall", note: "likely n/a — use the export_html RPC command" },

	// n/a — interactive/mode-only.
	"--help": { disposition: "na", aliases: ["-h"] },
	"--version": { disposition: "na", aliases: ["-v"] },
	"--print": { disposition: "na", aliases: ["-p"] },
	"--list-models": { disposition: "na" },
};

function hasYamlField(config: ServiceConfig, field: string): boolean {
	if (field === "(implicit)") return true;
	if (field.startsWith("model.")) {
		if (!config.model) return false;
		const sub = field.slice(6) as keyof NonNullable<ServiceConfig["model"]>;
		return config.model[sub] !== undefined;
	}
	const val = config[field as keyof ServiceConfig];
	return val !== undefined;
}

/**
 * Validate that args and YAML fields don't conflict. Returns an array of
 * human-readable error messages (empty if valid).
 */
export function validateNoConflicts(config: ServiceConfig): string[] {
	const errors: string[] = [];

	for (const arg of config.args) {
		for (const { flag, field } of YAML_FLAG_CONFLICTS) {
			if (arg === flag || arg.startsWith(`${flag}=`)) {
				if (field === "(implicit)") {
					errors.push(
						`"${flag}" in args conflicts with pid — pid always injects ${flag} automatically. Remove it from args.`,
					);
				} else if (hasYamlField(config, field)) {
					errors.push(
						`"${flag}" in args conflicts with the "${field}" YAML field. Pick one: either set "${field}" in the YAML, or use "${flag}" in args — not both.`,
					);
				}
			}
		}
	}

	if (config.tools !== undefined && config.no_builtin_tools !== undefined) {
		errors.push(
			`"tools" and "no_builtin_tools" are mutually exclusive. Use "tools" for a universal allowlist, or "no_builtin_tools" to restrict only built-in tools while keeping extension tools.`,
		);
	}

	return errors;
}

/**
 * Build the pi CLI args array from a validated service config.
 * pid always injects --mode rpc --session-id <name>. YAML fields
 * are appended as additional flags. User args come last.
 */
export function buildPiArgs(config: ServiceConfig): string[] {
	const args: string[] = ["--mode", "rpc", "--session-id", config.name];

	if (config.model?.provider) {
		args.push("--provider", config.model.provider);
	}
	if (config.model?.id) {
		args.push("--model", config.model.id);
	}
	if (config.model?.thinking) {
		args.push("--thinking", config.model.thinking);
	}
	if (config.model?.scoped && config.model.scoped.length > 0) {
		args.push("--models", config.model.scoped.join(","));
	}

	if (config.tools === false) {
		args.push("--no-tools");
	} else if (Array.isArray(config.tools)) {
		args.push("--tools", config.tools.join(","));
	}

	if (config.no_builtin_tools) {
		args.push("--no-builtin-tools");
	}

	if (config.extensions === false) {
		args.push("--no-extensions");
	} else if (Array.isArray(config.extensions)) {
		args.push("--no-extensions");
		for (const ext of config.extensions) {
			args.push("-e", ext);
		}
	}

	if (config.skills === false) {
		args.push("--no-skills");
	} else if (Array.isArray(config.skills)) {
		args.push("--no-skills");
		for (const skill of config.skills) {
			args.push("--skill", skill);
		}
	}

	if (config.context_files === false) {
		args.push("--no-context-files");
	}

	if (config.system_prompt) {
		args.push("--system-prompt", config.system_prompt);
	}

	if (config.append_system_prompt) {
		args.push("--append-system-prompt", config.append_system_prompt);
	}

	args.push(...config.args);

	return args;
}
