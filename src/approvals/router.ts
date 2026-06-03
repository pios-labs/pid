/**
 * Approval router (ADR 0004): the third `onServiceEvent` consumer. It routes pi's interactive
 * dialogs (`extension_ui_request`) to a single CLI inbox so a headless agent can still get a
 * human answer, and auto-answers the ones policy says are safe.
 *
 * It is the only consumer that *writes back* to pi (over stdin, via the `send` action built in
 * increment A) and it annotates the chronicle (via `logApproval`, the documented `pid_approval`
 * event — ADR 0004 §11 / ADR 0005). The pure policy decision lives in `matcher.classify`; this
 * file owns the I/O: correlation, the inbox, timeouts, and replies.
 *
 * Correlation (ADR 0004 §5, verified against pi): an `extension_ui_request` carries no tool link,
 * so a dialog is attributed to the **most-recently-started in-flight tool** — which pi's agent
 * loop guarantees is the one that raised it (it `await`s each tool's `beforeToolCall`, where the
 * dialog fires, before emitting the next tool's `tool_execution_start`). A dialog with no in-flight
 * tool is *free-standing* and always enqueues.
 *
 * Decision (ADR 0004 §§3–4): only `confirm` is auto-answerable (a safe machine `true`), and only
 * when correlated and `matcher.classify` returns `approve`. `select`/`input`/`editor` always
 * enqueue (no safe value to fabricate); fire-and-forget methods (`notify`, `setStatus`, …) need no
 * response and are left alone (they're already in the chronicle as the raw pi event).
 */

import { classify } from "./matcher.js";

/** A pi extension UI request as it appears on the RPC stream (flat fields; `crypto.randomUUID()` id). */
export interface ExtensionUiRequest {
	type: "extension_ui_request";
	id: string;
	method:
		| "confirm"
		| "select"
		| "input"
		| "editor"
		| "notify"
		| "setStatus"
		| "setWidget"
		| "setTitle"
		| "set_editor_text";
	[key: string]: unknown;
}

/** The dialog methods that block awaiting a host response. Everything else is fire-and-forget. */
const RESPONSE_METHODS = new Set(["confirm", "select", "input", "editor"]);

/** Per-service approval policy (the validated YAML fields, ADR 0004 §§1–2,6). */
export interface ApprovalPolicy {
	gate: string[];
	autoApprove: string[];
	onUnmatched: "approve" | "ask";
}

/** The supervisor capabilities the router drives. Implemented by the Supervisor. */
export interface ApprovalActions {
	/** Reply to pi over the service's stdin (increment A). Rejects if the service isn't running. */
	send(name: string, message: unknown): Promise<void>;
	/** Append a documented `pid_approval` event to the service's chronicle (ADR 0004 §11). No-op if not running. */
	logApproval(name: string, data: Record<string, unknown>): void;
}

/** A dialog awaiting a human answer, surfaced by `pid approvals`. Keyed in the inbox by `id`. */
export interface PendingApproval {
	/** pi's request id (a UUID — globally unique, so it doubles as the inbox key). */
	id: string;
	service: string;
	method: string;
	receivedAt: string;
	/** Correlated in-flight tool, if any (absent for a free-standing dialog). */
	toolName?: string;
	command?: string;
	/** The original request, for rendering the prompt. */
	request: ExtensionUiRequest;
}

/** A tool currently executing (start seen, end not yet) — a correlation-stack entry. */
interface InFlightTool {
	toolCallId: string;
	toolName: string;
	/** The bash command, when the tool is bash; undefined otherwise. */
	command?: string;
}

interface Tracked {
	policy: ApprovalPolicy;
	/** In-flight tools in start order; the last element is the most recent (the correlation target). */
	inFlight: InFlightTool[];
}

export interface ApprovalRouterOptions {
	actions: ApprovalActions;
	now?: () => number;
}

export class ApprovalRouter {
	private readonly actions: ApprovalActions;
	private readonly now: () => number;
	private readonly tracked = new Map<string, Tracked>();
	/** Pending approvals across all services, keyed by request id (UUID). In-memory only (ADR 0004 §7). */
	private readonly inbox = new Map<string, PendingApproval>();
	/** Timeout-expiry timers, keyed by request id. */
	private readonly timers = new Map<string, ReturnType<typeof setTimeout>>();

	constructor(opts: ApprovalRouterOptions) {
		this.actions = opts.actions;
		this.now = opts.now ?? Date.now;
	}

	/** Start tracking a service's approval policy. */
	register(name: string, policy: ApprovalPolicy): void {
		this.tracked.set(name, { policy, inFlight: [] });
	}

	/**
	 * Handle one parsed subprocess event: track in-flight tools and route dialogs. Synchronous state
	 * mutation (events arrive serialized from the JSONL reader); replies are fire-and-forget. No-op
	 * for untracked services and irrelevant events.
	 */
	handleEvent(name: string, event: unknown): void {
		const t = this.tracked.get(name);
		if (!t || typeof event !== "object" || event === null) return;
		const ev = event as Record<string, unknown>;

		switch (ev.type) {
			case "tool_execution_start": {
				if (typeof ev.toolCallId !== "string") return;
				t.inFlight.push({
					toolCallId: ev.toolCallId,
					toolName: typeof ev.toolName === "string" ? ev.toolName : "unknown",
					command: extractCommand(ev.args),
				});
				return;
			}
			case "tool_execution_end": {
				if (typeof ev.toolCallId !== "string") return;
				const i = t.inFlight.findIndex((f) => f.toolCallId === ev.toolCallId);
				if (i !== -1) t.inFlight.splice(i, 1);
				return;
			}
			case "extension_ui_request": {
				if (typeof ev.id !== "string" || typeof ev.method !== "string") return;
				this.route(name, t, ev as unknown as ExtensionUiRequest);
				return;
			}
			default:
				return;
		}
	}

	/** All pending approvals across services (for `pid approvals`). */
	list(): PendingApproval[] {
		return [...this.inbox.values()];
	}

	/**
	 * Answer a pending dialog affirmatively (the `pid approve` path). For `confirm` replies
	 * `confirmed: true`; for `select`/`input`/`editor` replies `value`. Throws if the id isn't
	 * pending (already resolved, expired, or unknown).
	 */
	async approve(id: string, value = ""): Promise<PendingApproval> {
		const entry = this.claim(id);
		const reply =
			entry.method === "confirm"
				? { type: "extension_ui_response", id, confirmed: true }
				: { type: "extension_ui_response", id, value };
		await this.actions.send(entry.service, reply);
		this.actions.logApproval(entry.service, {
			...this.context(entry),
			phase: "resolve",
			decision: "approve",
			by: "cli",
			value: entry.method === "confirm" ? null : value,
		});
		return entry;
	}

	/**
	 * Deny a pending dialog (the `pid deny` path). For `confirm` replies `confirmed: false`; for the
	 * others replies `cancelled: true`. Throws if the id isn't pending.
	 */
	async deny(id: string, reason?: string): Promise<PendingApproval> {
		const entry = this.claim(id);
		const reply =
			entry.method === "confirm"
				? { type: "extension_ui_response", id, confirmed: false }
				: { type: "extension_ui_response", id, cancelled: true };
		await this.actions.send(entry.service, reply);
		this.actions.logApproval(entry.service, {
			...this.context(entry),
			phase: "resolve",
			decision: "deny",
			by: "cli",
			...(reason ? { reason } : {}),
		});
		return entry;
	}

	/** Cancel all timers (daemon shutdown), mirroring the cost governor's dispose(). */
	dispose(): void {
		for (const timer of this.timers.values()) clearTimeout(timer);
		this.timers.clear();
	}

	/** Route a dialog: auto-answer a safe confirm, else enqueue for a human. */
	private route(name: string, t: Tracked, request: ExtensionUiRequest): void {
		// Fire-and-forget (notify/setStatus/…): no response expected; already in the chronicle.
		if (!RESPONSE_METHODS.has(request.method)) return;

		// Correlate to the most-recently-started in-flight tool (undefined ⇒ free-standing).
		const correlated = t.inFlight[t.inFlight.length - 1];

		if (request.method === "confirm" && correlated) {
			const verdict = classify({
				toolName: correlated.toolName,
				command: correlated.command,
				gate: t.policy.gate,
				autoApprove: t.policy.autoApprove,
				onUnmatched: t.policy.onUnmatched,
			});
			if (verdict === "approve") {
				void this.actions.send(name, { type: "extension_ui_response", id: request.id, confirmed: true });
				this.actions.logApproval(name, {
					id: request.id,
					phase: "resolve",
					decision: "auto_approve",
					by: "policy",
					method: request.method,
					toolName: correlated.toolName,
					...(correlated.command !== undefined ? { command: correlated.command } : {}),
				});
				return;
			}
		}

		// Everything else goes to a human: select/input/editor (no safe auto-answer), a gated confirm,
		// or a free-standing confirm (the extension deliberately wanted a person).
		this.enqueue(name, request, correlated);
	}

	private enqueue(name: string, request: ExtensionUiRequest, correlated?: InFlightTool): void {
		const entry: PendingApproval = {
			id: request.id,
			service: name,
			method: request.method,
			receivedAt: new Date(this.now()).toISOString(),
			toolName: correlated?.toolName,
			command: correlated?.command,
			request,
		};
		this.inbox.set(request.id, entry);
		this.actions.logApproval(name, { ...this.context(entry), phase: "enqueue", verdict: "enqueue" });

		// If pi attached a timeout it auto-resolves on its own clock and ignores a late reply
		// (ADR 0004 §8); drop our inbox entry at the same deadline rather than chase it.
		const timeout = typeof request.timeout === "number" ? request.timeout : undefined;
		if (timeout && timeout > 0) {
			const timer = setTimeout(() => this.expire(request.id), timeout);
			timer.unref?.();
			this.timers.set(request.id, timer);
		}
	}

	private expire(id: string): void {
		const entry = this.inbox.get(id);
		if (!entry) return;
		this.inbox.delete(id);
		this.clearTimer(id);
		this.actions.logApproval(entry.service, {
			...this.context(entry),
			phase: "resolve",
			decision: "expired",
			by: "timeout",
		});
	}

	/** Remove and return a pending entry, claiming it atomically so a racing timeout can't double-resolve. */
	private claim(id: string): PendingApproval {
		const entry = this.inbox.get(id);
		if (!entry) throw new Error(`no pending approval: ${id} (already resolved, expired, or unknown)`);
		this.inbox.delete(id);
		this.clearTimer(id);
		return entry;
	}

	private clearTimer(id: string): void {
		const timer = this.timers.get(id);
		if (timer) {
			clearTimeout(timer);
			this.timers.delete(id);
		}
	}

	/** The shared identifying fields for a `pid_approval` log entry. */
	private context(entry: PendingApproval): Record<string, unknown> {
		return {
			id: entry.id,
			method: entry.method,
			...(entry.toolName !== undefined ? { toolName: entry.toolName } : {}),
			...(entry.command !== undefined ? { command: entry.command } : {}),
		};
	}
}

/** Pull the bash command out of a tool's args (`args.command`), or undefined for non-bash tools. */
function extractCommand(args: unknown): string | undefined {
	if (args && typeof args === "object" && typeof (args as { command?: unknown }).command === "string") {
		return (args as { command: string }).command;
	}
	return undefined;
}
