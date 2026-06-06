import type { LogEnvelope } from "../util/log.js";

/**
 * The lean line-oriented `pid logs` / `pid tail` view (ADR 0008 fork 2A): one compact line per
 * chronicle event — `[service]  HH:MM:SS  <label>  <summary>` — for fast triage. The full transcript
 * is the dashboard's job. Pure and defensive: every pi/pid payload is read through optional access so
 * an unexpected shape degrades to just the label, never throws.
 */

export interface LogLineOptions {
	/** Prefix each line with the service name (the `pid tail` multiplex; off for single-service `logs`). */
	withService?: boolean;
	/** Width to pad the service column to when `withService` is set. */
	serviceWidth?: number;
}

/** Render one envelope as a single triage line. */
export function formatLogLine(env: LogEnvelope, opts: LogLineOptions = {}): string {
	const time = env.ts.slice(11, 19); // HH:MM:SS from the ISO `ts`
	const label = logLabel(env).padEnd(20);
	const summary = logSummary(env);
	const head = opts.withService ? `${env.service.padEnd(opts.serviceWidth ?? 14)}  ` : "";
	return `${head}${time}  ${label}  ${summary}`.trimEnd();
}

/** The local calendar day (`YYYY-MM-DD`) of an envelope — drives the `pid logs` date separators. */
export function logDay(env: LogEnvelope): string {
	return env.ts.slice(0, 10);
}

/** The label column: a tool's name for tool events, else the event type (pid_* types self-identify). */
function logLabel(env: LogEnvelope): string {
	const d = asObject(env.data);
	if (env.type === "tool_execution_start" || env.type === "tool_execution_end") {
		return str(d.toolName) ?? "tool";
	}
	return env.type;
}

/** The summary column: a short, type-specific gloss. Best-effort; "" when there's nothing useful. */
function logSummary(env: LogEnvelope): string {
	const d = asObject(env.data);
	switch (env.type) {
		case "tool_execution_start":
			return clip(str(asObject(d.args).command) ?? compactArgs(d.args), 80);
		case "tool_execution_end":
			return d.isError ? "→ error" : "→ ok";
		case "message_end":
			return messageSummary(d);
		case "extension_ui_request":
			return clip(str(d.message) ?? str(d.title) ?? str(d.method) ?? "", 80);
		case "pid_approval":
			return approvalSummary(d);
		case "pid_budget_pause":
			return budgetPauseSummary(d);
		case "pid_budget_resume":
			return `resumed (${str(d.by) ?? "?"})`;
		case "pid_quarantine":
			return `${str(d.signature) ?? "?"} ×${num(d.count) ?? "?"}/${num(d.threshold) ?? "?"}`;
		case "pid_parse_error":
			return clip(str(d.raw) ?? str(d.error) ?? "", 80);
		default:
			return "";
	}
}

/** `message_end`: the assistant's cost (the high-signal field on a completed message). */
function messageSummary(data: Record<string, unknown>): string {
	const cost = num(asObject(asObject(asObject(data.message).usage).cost).total);
	return cost === undefined ? "" : `$${cost.toFixed(cost < 0.01 ? 4 : 2)}`;
}

/** `pid_approval`: phase + decision + the command/method it concerned. */
function approvalSummary(d: Record<string, unknown>): string {
	const phase = str(d.phase) ?? "";
	const decision = str(d.decision);
	const what = str(d.command) ?? str(d.method) ?? "";
	return [phase, decision, what].filter(Boolean).join("  ");
}

/** `pid_budget_pause`: the tripped caps + the resume time. */
function budgetPauseSummary(d: Record<string, unknown>): string {
	const breached = Array.isArray(d.breached) ? d.breached : [];
	const caps = breached
		.map((b) => {
			const o = asObject(b);
			return `${str(o.cap) ?? "?"} ${num(o.spent) ?? "?"}/${num(o.limit) ?? "?"}`;
		})
		.join(", ");
	const resume = str(d.resumeAt);
	return resume ? `${caps} → resume ${resume.slice(11, 16)}` : caps;
}

/** A non-bash tool's args, compacted to a short single line. */
function compactArgs(args: unknown): string {
	const o = asObject(args);
	const keys = Object.keys(o);
	if (keys.length === 0) return "";
	return clip(JSON.stringify(o), 80);
}

// --- safe accessors: the chronicle holds verbatim pi payloads, so never assume a shape ---

function asObject(v: unknown): Record<string, unknown> {
	return v && typeof v === "object" ? (v as Record<string, unknown>) : {};
}
function str(v: unknown): string | undefined {
	return typeof v === "string" ? v : undefined;
}
function num(v: unknown): number | undefined {
	return typeof v === "number" ? v : undefined;
}
function clip(s: string, max: number): string {
	return s.length > max ? `${s.slice(0, max - 1)}…` : s;
}
