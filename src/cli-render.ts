/**
 * Human-readable CLI rendering (ADR 0006). pid's CLI prints rendered output by default and
 * exposes the raw daemon payload behind `--json`; these pure formatters are the render side.
 *
 * D1 introduces this for the approval inbox — the spec's "Product: approval inbox" — and the
 * pattern (a pure `format*(data, now?) → string`) is the template D2 generalises across the rest
 * of the CLI. Kept pure and clock-injected so each renderer is unit-testable in isolation,
 * matching the codebase's pure-core idiom (the matcher, the crash signature, the cost extractor).
 */

import type { PendingApproval } from "./approvals/router.js";
import type { ReloadSummary, ServiceStatus } from "./supervisor/index.js";

/**
 * `pid status [name]`: a detail block for one service, or the shared overview table for all.
 * Branches on the daemon's payload shape — single record vs array — so one renderer serves both
 * `status <name>` and `status` / `list`.
 */
export function formatStatus(data: ServiceStatus | ServiceStatus[], now: number): string {
	return Array.isArray(data) ? formatServiceTable(data, now) : formatServiceDetail(data, now);
}

/** `pid list` / `pid status` (all): the lean NAME/STATE/PID/UPTIME/PENDING overview + a count footer. */
export function formatServiceTable(services: ServiceStatus[], now: number): string {
	if (services.length === 0) return "No services.";
	const rows = services.map((s) => [
		s.name,
		stateCell(s),
		s.pid === undefined ? "-" : String(s.pid),
		s.startedAt ? formatAge(now - Date.parse(s.startedAt)) : "-",
		String(s.pendingApprovals),
	]);
	return `${table(["NAME", "STATE", "PID", "UPTIME", "PENDING"], rows)}\n\n${count(services.length, "service")}`;
}

/** `pid status <name>`: a labeled detail block. The `why` line shows only when a failure is recorded. */
export function formatServiceDetail(s: ServiceStatus, now: number): string {
	const lines = [s.name, `  state    ${s.state}`];
	if (s.pid !== undefined) lines.push(`  pid      ${s.pid}`);
	if (s.startedAt)
		lines.push(`  uptime   ${formatAge(now - Date.parse(s.startedAt))}  (since ${formatTime(s.startedAt)})`);
	const model = s.config.model ? modelLabel(s.config.model) : "";
	lines.push(`  command  ${s.config.command}${model ? `  (model: ${model})` : ""}`);
	lines.push(`  pending  ${count(s.pendingApprovals, "approval")}`);
	if (s.lastFailure) {
		const prefix = s.state === "quarantined" ? "crash loop: " : "";
		lines.push(`  why      ${prefix}${s.lastFailure.signature}  (${formatTime(s.lastFailure.at)})`);
	}
	if (s.orphaned) lines.push("  note     removed on disk (orphaned) — deregisters when it next stops");
	if (s.configChanged) lines.push("  note     config changed on disk — restart to apply");
	return lines.join("\n");
}

/** The STATE cell for the overview table, annotated with reload flags (ADR 0010) when set. */
function stateCell(s: ServiceStatus): string {
	const flags = [s.orphaned ? "orphaned" : "", s.configChanged ? "config-changed" : ""].filter(Boolean);
	return flags.length ? `${s.state} (${flags.join(",")})` : s.state;
}

/**
 * `pid reload`: the reconcile summary (ADR 0010), one section per non-empty disposition. The empty
 * case still confirms the reload ran (so a no-op isn't mistaken for a failure).
 */
export function formatReloadSummary(s: ReloadSummary): string {
	const lines: string[] = [];
	const section = (label: string, names: string[]) => {
		if (names.length) lines.push(`  ${label}: ${names.join(", ")}`);
	};
	section("added", s.added);
	section("updated", s.updated);
	section("staged (restart to apply)", s.staged);
	section("orphaned (removed on disk, still running)", s.orphaned);
	section("removed", s.removed);
	for (const e of s.errors) lines.push(`  error ${e.file}: ${e.error}`);
	return lines.length === 0 ? "Reloaded — no changes." : `Reloaded.\n${lines.join("\n")}`;
}

/** Action-command receipt (`start`/`stop`/`resume`/…), mirroring D1's approve/deny receipts. */
export function formatActionReceipt(verb: string, name: string, state?: string): string {
	return state ? `✓ ${verb} ${name} → ${state}` : `✓ ${verb} ${name}`;
}

/** `<n> thing` / `<n> things` — pluralise an English count noun. */
function count(n: number, noun: string): string {
	return `${n} ${noun}${n === 1 ? "" : "s"}`;
}

/** A service's configured model as `provider/id`, with an optional `thinking:<level>` suffix. */
function modelLabel(m: { provider?: string; id?: string; thinking?: string }): string {
	const base = [m.provider, m.id].filter(Boolean).join("/");
	return m.thinking ? `${base || "?"} thinking:${m.thinking}` : base;
}

/** A UTC ISO timestamp as a friendly `YYYY-MM-DD HH:MM UTC` (timestamps are always our own toISOString()). */
function formatTime(iso: string): string {
	return `${iso.slice(0, 10)} ${iso.slice(11, 16)} UTC`;
}

/** `pid approvals`: the pending-inbox table (ID / SERVICE / METHOD / AGE / PROMPT), or an empty note. */
export function formatApprovalsTable(entries: PendingApproval[], now: number): string {
	if (entries.length === 0) return "No pending approvals.";
	const rows = entries.map((e) => [
		shortId(e.id),
		e.service,
		e.method,
		formatAge(now - Date.parse(e.receivedAt)),
		promptText(e),
	]);
	return table(["ID", "SERVICE", "METHOD", "AGE", "PROMPT"], rows);
}

/** `pid approve`: a one-line receipt. Shows the supplied value for non-confirm methods. */
export function formatApproveReceipt(entry: PendingApproval, value?: string): string {
	const note = entry.method === "confirm" || value === undefined ? "" : `  (value: ${valueSummary(value)})`;
	return `✓ approved ${shortId(entry.id)} → ${entry.service}${note}`;
}

/** `pid deny`: a one-line receipt. */
export function formatDenyReceipt(entry: PendingApproval): string {
	return `✓ denied ${shortId(entry.id)} → ${entry.service}`;
}

/**
 * Display form of a request id: the first 8 chars. pi's ids are random UUIDs, unique well within
 * that, so the inbox shows the short form and the operator types just a prefix — resolution
 * (`resolveApprovalId`) accepts any unambiguous prefix, exactly like a git short SHA.
 */
export function shortId(id: string): string {
	return id.slice(0, 8);
}

/** Short, scannable prompt for the table: the dialog's title, falling back to its message. */
function promptText(entry: PendingApproval): string {
	const request = entry.request as { title?: unknown; message?: unknown };
	const title = typeof request.title === "string" ? request.title : "";
	const message = typeof request.message === "string" ? request.message : "";
	return title || message || entry.method;
}

/** A long value (an editor document) is summarised by length rather than dumped into the receipt. */
function valueSummary(value: string): string {
	return value.length > 40 ? `${value.length} chars` : value;
}

/** Coarse relative age: 5s / 3m / 2h / 1d. */
function formatAge(ms: number): string {
	const s = Math.max(0, Math.floor(ms / 1000));
	if (s < 60) return `${s}s`;
	const m = Math.floor(s / 60);
	if (m < 60) return `${m}m`;
	const h = Math.floor(m / 60);
	if (h < 24) return `${h}h`;
	return `${Math.floor(h / 24)}d`;
}

/** Render a left-aligned, space-padded text table. Columns sized to their widest cell. */
function table(headers: string[], rows: string[][]): string {
	const widths = headers.map((h, i) => Math.max(h.length, ...rows.map((r) => (r[i] ?? "").length)));
	const line = (cells: string[]) =>
		cells
			.map((c, i) => c.padEnd(widths[i] ?? 0))
			.join("  ")
			.trimEnd();
	return [line(headers), ...rows.map(line)].join("\n");
}
