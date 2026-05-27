import { z } from "zod";

const triggerSchema = z.discriminatedUnion("type", [
	z.object({ type: z.literal("manual") }),
	z.object({ type: z.literal("cron"), schedule: z.string() }),
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
	on_exceed: z.enum(["pause", "quarantine", "notify"]).default("pause"),
	reset_tz: z.string().default("UTC"),
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

export const serviceSchema = z.object({
	name: z.string().regex(/^[a-z0-9][a-z0-9-]{0,62}$/, "name must be kebab-case"),
	command: z.string().default("pi"),
	args: z.array(z.string()).default(["--mode", "rpc", "--no-session"]),
	cwd: z.string().optional(),
	env: z.record(z.string()).default({}),
	prompt: z.string().optional(),
	trigger: triggerSchema.default({ type: "manual" }),
	budget: budgetSchema.optional(),
	restart: restartSchema.default({}),
	quarantine: quarantineSchema.default({}),
	gate: z.array(z.string()).default([]),
	auto_approve: z.array(z.string()).default([]),
});

export type ServiceConfig = z.infer<typeof serviceSchema>;
