/**
 * Client-side approval interaction (ADR 0006, D2(b)+(d)). The daemon is a structured control plane
 * with no terminal, so resolving a human-typed short id and gathering an interactive value both live
 * here in the CLI — the human layer. The resolved value still flows through the router's fail-closed
 * `buildApproveReply` validation, so this module is ergonomics, never the safety boundary.
 *
 * The per-method affordances mirror pi's own interactive components (a numbered picker, a line
 * prompt, an `$EDITOR` breakout) — see `pi/.../modes/interactive/components/extension-{selector,
 * input,editor}.ts`. pid is a plain CLI (no TUI to stop/start), so it drives `readline`/`spawn`
 * directly. Resolution (`resolveApprovalId`) is pure and unit-tested; the prompts do I/O.
 */

import { spawn } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { stdin, stdout } from "node:process";
import { createInterface } from "node:readline/promises";
import type { PendingApproval } from "./approvals/router.js";
import { shortId } from "./cli-render.js";

/** Thrown when the operator backs out of value entry. The CLI leaves the request pending (sends nothing). */
export class ValueEntryCancelled extends Error {
	constructor() {
		super("value entry cancelled");
		this.name = "ValueEntryCancelled";
	}
}

/**
 * Resolve a typed id (full or a prefix) to exactly one pending approval. An exact id always wins;
 * otherwise a unique prefix match is required. Pure — the CLI fetches the inbox and passes it in.
 * Throws a user-facing message on no match or an ambiguous prefix (listing the candidates).
 */
export function resolveApprovalId(idOrPrefix: string, entries: PendingApproval[]): PendingApproval {
	const exact = entries.find((e) => e.id === idOrPrefix);
	if (exact) return exact;
	const matches = entries.filter((e) => e.id.startsWith(idOrPrefix));
	if (matches.length === 1) return matches[0] as PendingApproval;
	if (matches.length === 0) throw new Error(`no pending approval matching '${idOrPrefix}'`);
	throw new Error(
		`ambiguous id '${idOrPrefix}' matches ${matches.length}: ${matches.map((m) => shortId(m.id)).join(", ")}`,
	);
}

/**
 * Interactively gather the value for a non-`confirm` dialog: a numbered picker (`select`), a line
 * prompt (`input`), or an `$EDITOR` breakout (`editor`). Requires a TTY — a non-interactive caller
 * must pass `--value`. Throws `ValueEntryCancelled` when the operator backs out.
 */
export async function promptValue(entry: PendingApproval): Promise<string> {
	if (!stdin.isTTY) {
		throw new Error(`approval ${shortId(entry.id)} (${entry.method}) needs a value; not a tty — pass --value`);
	}
	switch (entry.method) {
		case "select":
			return promptSelect(entry);
		case "input":
			return promptInput(entry);
		case "editor":
			return promptEditor(entry);
		default:
			throw new Error(`cannot prompt for method '${entry.method}'`);
	}
}

/** A numbered picker; re-prompts on an out-of-range answer (mirrors pi staying in the selector). */
async function promptSelect(entry: PendingApproval): Promise<string> {
	const options = optionsOf(entry);
	if (options.length === 0) throw new Error(`select ${shortId(entry.id)} offers no options`);
	const rl = createInterface({ input: stdin, output: stdout });
	try {
		stdout.write(`${titleOf(entry)}\n`);
		options.forEach((o, i) => {
			stdout.write(`  ${i + 1}) ${o}\n`);
		});
		while (true) {
			const answer = (await rl.question(`Select [1-${options.length}] (q to cancel): `)).trim();
			if (answer === "" || answer.toLowerCase() === "q") throw new ValueEntryCancelled();
			const n = Number(answer);
			if (Number.isInteger(n) && n >= 1 && n <= options.length) return options[n - 1] as string;
			stdout.write(`Not a choice between 1 and ${options.length}.\n`);
		}
	} finally {
		rl.close();
	}
}

/** A one-line prompt. Empty is a valid value (pi's Input submits empty); only Ctrl-C aborts. */
async function promptInput(entry: PendingApproval): Promise<string> {
	const rl = createInterface({ input: stdin, output: stdout });
	try {
		const placeholder = strField(entry, "placeholder");
		stdout.write(`${titleOf(entry)}${placeholder ? ` (${placeholder})` : ""}\n`);
		return await rl.question("> ");
	} finally {
		rl.close();
	}
}

/**
 * An `$EDITOR` breakout, mirroring pi's `extension-editor.ts`: `$VISUAL || $EDITOR`, a temp file
 * seeded with the dialog's prefill, `spawn` with inherited stdio, and on a clean exit the file is
 * read back with one trailing newline stripped. A non-zero/failed exit is a cancel.
 */
async function promptEditor(entry: PendingApproval): Promise<string> {
	const editorCmd = process.env.VISUAL || process.env.EDITOR;
	if (!editorCmd) throw new Error("no editor configured; set $VISUAL or $EDITOR, or pass --value");
	const prefill = strField(entry, "prefill") ?? "";
	const dir = await mkdtemp(join(tmpdir(), "pid-approval-"));
	const file = join(dir, `${shortId(entry.id)}.md`);
	try {
		await writeFile(file, prefill, "utf8");
		const [cmd, ...args] = editorCmd.split(" ");
		const code = await new Promise<number | null>((resolve) => {
			const child = spawn(cmd as string, [...args, file], { stdio: "inherit", shell: process.platform === "win32" });
			child.on("error", () => resolve(null));
			child.on("close", (c) => resolve(c));
		});
		if (code !== 0) throw new ValueEntryCancelled();
		return (await readFile(file, "utf8")).replace(/\n$/, "");
	} finally {
		await rm(dir, { recursive: true, force: true });
	}
}

/** The `select` dialog's string options (defensive against a malformed request). */
function optionsOf(entry: PendingApproval): string[] {
	const o = (entry.request as { options?: unknown }).options;
	return Array.isArray(o) ? o.filter((x): x is string => typeof x === "string") : [];
}

/** The dialog's human prompt: title, then message, then the method name as a last resort. */
function titleOf(entry: PendingApproval): string {
	const r = entry.request as { title?: unknown; message?: unknown };
	if (typeof r.title === "string" && r.title) return r.title;
	if (typeof r.message === "string" && r.message) return r.message;
	return entry.method;
}

/** A non-empty string field off the original request (e.g. `placeholder`, `prefill`), else undefined. */
function strField(entry: PendingApproval, key: string): string | undefined {
	const v = (entry.request as Record<string, unknown>)[key];
	return typeof v === "string" && v ? v : undefined;
}
