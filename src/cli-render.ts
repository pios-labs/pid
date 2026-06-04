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

/** `pid approvals`: the pending-inbox table (ID / SERVICE / METHOD / AGE / PROMPT), or an empty note. */
export function formatApprovalsTable(entries: PendingApproval[], now: number): string {
	if (entries.length === 0) return "No pending approvals.";
	const rows = entries.map((e) => [e.id, e.service, e.method, formatAge(now - Date.parse(e.receivedAt)), promptText(e)]);
	return table(["ID", "SERVICE", "METHOD", "AGE", "PROMPT"], rows);
}

/** `pid approve`: a one-line receipt. Shows the supplied value for non-confirm methods. */
export function formatApproveReceipt(entry: PendingApproval, value?: string): string {
	const note = entry.method === "confirm" || value === undefined ? "" : `  (value: ${valueSummary(value)})`;
	return `✓ approved ${entry.id} → ${entry.service}${note}`;
}

/** `pid deny`: a one-line receipt. */
export function formatDenyReceipt(entry: PendingApproval): string {
	return `✓ denied ${entry.id} → ${entry.service}`;
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
