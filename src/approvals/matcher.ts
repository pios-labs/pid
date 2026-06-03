/**
 * Approval matcher — the pure policy core of the approval router (ADR 0004).
 *
 * Given a correlated dialog (the in-flight tool name, and for the bash tool its command text)
 * plus a service's policy, it returns a single verdict: `approve` (answer the dialog
 * automatically) or `enqueue` (send it to a human). All the router's I/O — correlation,
 * confirm-vs-richer-dialog handling, the inbox, replying over stdin — lives in `router.ts`
 * (increment C); this file is sealed, deterministic, and side-effect-free so it can be tested
 * exhaustively against ADR 0004's worked tables.
 *
 * The model, in one breath (ADR 0004 §§1–3, 6):
 *
 *   - Two postures, chosen by `on_unmatched`: **trusting** (`approve`, the default — "run
 *     freely, stop for the dangerous few", a small `gate` block-list) and **cautious** (`ask` —
 *     "only do these few things, ask about the rest", a small `auto_approve` allow-list).
 *   - One descriptor grammar for both lists: `<tool>` (a bare pi tool name, matches the dialog's
 *     tool) or `bash:<phrase>` (the bash tool plus one or more space-separated whole-word tokens).
 *   - Asymmetric matching, both biased toward "ask": `gate` **over-matches** (the phrase appears
 *     as consecutive tokens *anywhere* — a false positive only costs one extra question, so we
 *     tokenize aggressively and quote-blind, catching `$(echo rm)`, `x=rm`, `xargs rm`).
 *     `auto_approve` **under-matches, fail-closed** (every `&&`/`;`/`|` segment's *leading* words
 *     must prefix-match a blessed phrase; substitution / `$VAR` / `eval` / unbalanced quotes →
 *     bail to "ask", never approve on a partial read).
 *   - Decision order: `auto_approve` (under) wins → approve; else `gate` (over) → enqueue; else
 *     the `on_unmatched` posture default.
 */

/** pi's seven built-in tools (ADR 0004 §6; pi `core/tools/index.ts`, recorded as memory D1). */
export const KNOWN_PI_TOOLS = ["bash", "read", "write", "edit", "grep", "find", "ls"] as const;
export type PiTool = (typeof KNOWN_PI_TOOLS)[number];

/** A parsed policy descriptor: a bare `<tool>`, or `bash:<phrase>` where `phrase` is its whole words. */
export interface Descriptor {
	tool: string;
	/** Present iff the descriptor was `bash:<phrase>`; the phrase split into whole-word tokens. */
	phrase?: string[];
}

/** Thrown by `parseDescriptor` on a malformed entry; surfaced by schema validation at load time. */
export class DescriptorError extends Error {}

/**
 * Parse one policy descriptor: `<tool>` or `bash:<phrase>`. Throws `DescriptorError` on an unknown
 * bare tool (the classic `gate: [rm]` typo) or a non-bash `tool:` form (bash-only in v0). The
 * schema uses this to reject bad policy at load; `classify` uses it (leniently) at match time.
 */
export function parseDescriptor(raw: string): Descriptor {
	const s = raw.trim();
	if (!s) throw new DescriptorError("empty descriptor");

	const colon = s.indexOf(":");
	if (colon === -1) {
		if (!(KNOWN_PI_TOOLS as readonly string[]).includes(s)) {
			throw new DescriptorError(
				`unknown descriptor "${s}": a bare token must be a pi tool name (${KNOWN_PI_TOOLS.join(", ")}). ` +
					`To match the "${s}" command, write "bash:${s}".`,
			);
		}
		return { tool: s };
	}

	const tool = s.slice(0, colon);
	const phraseStr = s.slice(colon + 1).trim();
	if (tool !== "bash") {
		throw new DescriptorError(
			`"${tool}:..." is not supported: the "<tool>:<phrase>" form is bash-only in v0. ` +
				`Use a bare "${tool}" to match that whole tool.`,
		);
	}
	if (!phraseStr) throw new DescriptorError(`empty phrase in "${raw}" — write e.g. "bash:rm" or "bash:git push".`);
	return { tool: "bash", phrase: phraseStr.split(/\s+/) };
}

export type Verdict = "approve" | "enqueue";

export interface ClassifyInput {
	/** The correlated in-flight tool (e.g. "bash"); free-standing dialogs are handled by the router, not here. */
	toolName: string;
	/** The bash command text, when the in-flight tool is bash. Undefined for non-bash tools. */
	command?: string;
	/** Raw `gate` descriptors from the service config (validated at load). */
	gate: string[];
	/** Raw `auto_approve` descriptors from the service config (validated at load). */
	autoApprove: string[];
	/** Posture for a dialog that matches neither list. */
	onUnmatched: "approve" | "ask";
}

/**
 * Classify a correlated dialog into a single verdict (ADR 0004 §3). `auto_approve` (under-match)
 * is checked first and wins; then `gate` (over-match); then the `on_unmatched` posture.
 */
export function classify(input: ClassifyInput): Verdict {
	const gate = parseList(input.gate);
	const auto = parseList(input.autoApprove);

	if (autoApproves(auto, input.toolName, input.command)) return "approve";
	if (gates(gate, input.toolName, input.command)) return "enqueue";
	return input.onUnmatched === "approve" ? "approve" : "enqueue";
}

/** Parse a descriptor list, skipping any malformed entry (the schema already rejects those at load). */
function parseList(raw: string[]): Descriptor[] {
	const out: Descriptor[] = [];
	for (const r of raw) {
		try {
			out.push(parseDescriptor(r));
		} catch {
			// Defensive: validated upstream. A bad entry here simply never matches.
		}
	}
	return out;
}

/**
 * `gate` over-match: a bare `<tool>` matching the dialog's tool, or a `bash:<phrase>` whose words
 * appear as consecutive tokens *anywhere* in the command (quote-blind, aggressive tokenization).
 */
function gates(descriptors: Descriptor[], toolName: string, command?: string): boolean {
	for (const d of descriptors) {
		if (!d.phrase) {
			if (d.tool === toolName) return true;
			continue;
		}
		if (toolName === "bash" && command !== undefined && containsPhrase(gateTokens(command), d.phrase)) {
			return true;
		}
	}
	return false;
}

/**
 * `auto_approve` under-match, fail-closed: a bare `<tool>` blesses that whole tool unconditionally;
 * otherwise (bash only) the command must parse cleanly and *every* segment's leading words must
 * prefix-match some blessed phrase. Anything unparseable (substitution/`$VAR`/`eval`/unbalanced
 * quotes) makes the whole command bail — we never approve on a partial read.
 */
function autoApproves(descriptors: Descriptor[], toolName: string, command?: string): boolean {
	for (const d of descriptors) {
		if (!d.phrase && d.tool === toolName) return true;
	}

	const phrases = descriptors.filter((d) => d.tool === "bash" && d.phrase).map((d) => d.phrase as string[]);
	if (phrases.length === 0) return false;
	if (toolName !== "bash" || command === undefined) return false;

	const analysis = analyzeCommand(command);
	if (analysis.bail) return false;
	return analysis.segments.every((seg) => phrases.some((p) => isPrefix(p, seg)));
}

/**
 * Aggressive, quote-blind tokenizer for `gate` over-matching: every shell metacharacter, quote,
 * `$`, and `=` becomes a delimiter, so `$(echo rm)`, `x=rm`, and `'rm'` all surface `rm` as a
 * whole-word token. Over-approximation is safe here — a false positive is just an extra question.
 */
function gateTokens(command: string): string[] {
	return command
		.replace(/[&|;()<>="'`$]/g, " ")
		.split(/\s+/)
		.filter(Boolean);
}

/** True if `phrase` occurs as a consecutive run of whole tokens anywhere in `tokens`. */
function containsPhrase(tokens: string[], phrase: string[]): boolean {
	if (phrase.length === 0) return false;
	for (let i = 0; i + phrase.length <= tokens.length; i++) {
		if (phrase.every((w, j) => tokens[i + j] === w)) return true;
	}
	return false;
}

/** True if `phrase` is a leading prefix of `seg` (whole tokens). One-word phrases generalise head-level. */
function isPrefix(phrase: string[], seg: string[]): boolean {
	if (phrase.length === 0 || seg.length < phrase.length) return false;
	return phrase.every((w, j) => seg[j] === w);
}

/** Triggers that make `auto_approve` bail to "ask": command substitution, variable/positional
 * expansion, and subshell/process-substitution grouping. Detected unquoted; quoted occurrences are
 * literal but we still fail closed on them (over-cautious is the safe direction for an allow-list). */
const BAIL_CHARS = new Set(["$", "`", "(", ")"]);

/**
 * Quote-aware split of a bash command into `&&`/`||`/`;`/`|`/`&` segments, each tokenized into whole
 * words. Bails (no approve) on any substitution/variable/subshell construct, a leading `eval`, or an
 * unbalanced quote — the conservative reading that fails toward asking. Shell is undecidable
 * statically (substitution, `eval`), so we refuse to guess rather than approve on a partial parse.
 */
function analyzeCommand(command: string): { bail: true } | { bail: false; segments: string[][] } {
	const bail = { bail: true } as const;
	const segments: string[][] = [];
	let tokens: string[] = [];
	let cur = "";
	let quote: '"' | "'" | null = null;

	const endToken = () => {
		if (cur) {
			tokens.push(cur);
			cur = "";
		}
	};
	const endSegment = () => {
		endToken();
		segments.push(tokens);
		tokens = [];
	};

	const chars = [...command];
	for (let i = 0; i < chars.length; i++) {
		const c = chars[i];
		if (c === undefined) break;

		if (quote) {
			if (c === quote) quote = null;
			else cur += c;
			continue;
		}
		if (c === '"' || c === "'") {
			quote = c;
			continue;
		}
		if (BAIL_CHARS.has(c)) return bail;

		if (c === "&") {
			endSegment();
			if (chars[i + 1] === "&") i++;
			continue;
		}
		if (c === "|") {
			endSegment();
			if (chars[i + 1] === "|") i++;
			continue;
		}
		if (c === ";") {
			endSegment();
			continue;
		}
		if (/\s/.test(c)) {
			endToken();
			continue;
		}
		cur += c;
	}

	if (quote) return bail; // unbalanced quote
	endSegment();

	const nonEmpty = segments.filter((s) => s.length > 0);
	if (nonEmpty.length === 0) return bail; // nothing to bless (e.g. empty or only operators)
	for (const seg of nonEmpty) {
		if (seg[0] === "eval") return bail; // eval runs an unknowable command
	}
	return { bail: false, segments: nonEmpty };
}
