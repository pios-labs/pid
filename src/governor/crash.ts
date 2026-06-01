import type { ServiceConfig } from "../services/schema.js";

/**
 * Crash-loop detector (see ADR 0003): the second consumer behind the supervisor's
 * onServiceEvent seam. It names each failure with a coarse *signature*, keeps a
 * rolling per-service window of recent failures, and quarantines a service when the
 * same signature repeats above a threshold within the window — the "a human would
 * have pulled the plug" reflex, automated.
 *
 * Like the cost governor, the one place that knows pi's event shapes is the pure
 * extractor below (`deriveSignature`), pinned by unit tests; the supervisor forwards
 * events without understanding them, so an upstream pi shape change is a one-file fix.
 *
 * Quarantine is *terminal*: unlike a budget pause (which clears when the clock rolls),
 * a crash loop will not fix itself on a timer, so there is no auto-resume — a human
 * clears it with `pid unquarantine` once the underlying fault is fixed.
 *
 * Scope (ADR 0003 decision 4): v0 counts only the three *in-session* signals, which
 * loop while the process stays alive. The fourth source, a non-zero process exit
 * (`proc:exit_<code>`), can only *loop* once something relaunches the process — an
 * auto-restart policy or a trigger re-fire, neither of which exists yet — so it is
 * derived and shown on status by the supervisor but not yet fed here.
 */

/** The quarantine block as it appears post-parse (threshold + window always present via defaults). */
export type QuarantineConfig = ServiceConfig["quarantine"];

/** The supervisor capability the detector drives. Implemented by the Supervisor. */
export interface CrashActions {
	quarantine(name: string): Promise<void>;
}

/** One recorded failure: when it arrived (ISO) and its signature. */
export interface FailureEvent {
	at: string;
	signature: string;
}

export interface CrashStatus {
	quarantined: boolean;
	lastFailure: FailureEvent | null;
}

export interface CrashDetectorOptions {
	actions: CrashActions;
	now?: () => number;
}

/**
 * Walk an `agent_end` event's `messages[]` from the end and return the stopReason of
 * the last assistant message, or null. `stopReason` lives on the message, not on the
 * `agent_end` event itself (verified pi @ e56521e3, ADR 0003).
 */
function lastAssistantStopReason(messages: unknown): string | null {
	if (!Array.isArray(messages)) return null;
	for (let i = messages.length - 1; i >= 0; i--) {
		const m = messages[i] as Record<string, unknown> | null;
		if (m && typeof m === "object" && m.role === "assistant") {
			return typeof m.stopReason === "string" ? m.stopReason : null;
		}
	}
	return null;
}

/**
 * Derive a failure signature from a parsed subprocess event, or null if the event is
 * not a failure the crash detector should count. Defensive against malformed lines
 * (pid consumes an external stream). The exact event shapes are verified against pi
 * (ADR 0003) and this function is the only place that depends on them.
 */
export function deriveSignature(event: unknown): string | null {
	if (typeof event !== "object" || event === null) return null;
	const ev = event as Record<string, unknown>;
	switch (ev.type) {
		case "tool_execution_end": {
			// Only the boolean isError flag is available — no structured exit code — so the
			// signature is coarse by necessity.
			if (ev.isError !== true) return null;
			const tool = typeof ev.toolName === "string" ? ev.toolName : "unknown";
			return `tool:${tool}:error`;
		}
		case "extension_error": {
			const path = typeof ev.extensionPath === "string" ? ev.extensionPath : "unknown";
			const evt = typeof ev.event === "string" ? ev.event : "unknown";
			return `ext:${path}:${evt}`;
		}
		case "agent_end": {
			// Count only when pi has actually given up — not while it auto-retries a transient
			// error internally (willRetry === true) — AND the last assistant message stopped on a
			// genuine "error", not "aborted" (which is pid's own pause/stop, ADR 0001/0002). These
			// two guards are what stop pid miscounting its own interventions and pi's retries.
			if (ev.willRetry !== false) return null;
			if (lastAssistantStopReason(ev.messages) !== "error") return null;
			return "agent:error";
		}
		default:
			return null;
	}
}

interface Tracked {
	config: QuarantineConfig;
	/** Recent failures, newest-first. In memory only — resets on daemon restart (ADR 0003 decision 3). */
	recent: FailureEvent[];
	quarantined: boolean;
	/** Serializes records per service so concurrent events can't interleave the read-modify-write. */
	queue: Promise<void>;
}

export class CrashDetector {
	private readonly actions: CrashActions;
	private readonly now: () => number;
	private readonly tracked = new Map<string, Tracked>();

	constructor(opts: CrashDetectorOptions) {
		this.actions = opts.actions;
		this.now = opts.now ?? Date.now;
	}

	/** Start tracking a service's failures. */
	register(name: string, config: QuarantineConfig): void {
		this.tracked.set(name, { config, recent: [], quarantined: false, queue: Promise.resolve() });
	}

	/** Handle one parsed subprocess event. No-op for untracked services and non-failure events. */
	handleEvent(name: string, event: unknown): Promise<void> {
		const t = this.tracked.get(name);
		if (!t) return Promise.resolve();
		const signature = deriveSignature(event);
		if (signature === null) return Promise.resolve();
		t.queue = t.queue
			.then(() => this.record(name, t, signature))
			.catch((err) => {
				process.stderr.write(`[${name}] crash detector failed: ${err instanceof Error ? err.message : String(err)}\n`);
			});
		return t.queue;
	}

	status(name: string): CrashStatus | undefined {
		const t = this.tracked.get(name);
		if (!t) return undefined;
		return { quarantined: t.quarantined, lastFailure: t.recent[0] ?? null };
	}

	/**
	 * Clear failure history and the quarantine flag — the `pid unquarantine` path (increment C).
	 * The supervisor separately clears the persisted `quarantined` state in state.json.
	 */
	clear(name: string): void {
		const t = this.tracked.get(name);
		if (!t) return;
		t.recent = [];
		t.quarantined = false;
	}

	private async record(name: string, t: Tracked, signature: string): Promise<void> {
		const nowMs = this.now();
		t.recent.unshift({ at: new Date(nowMs).toISOString(), signature });
		// Prune anything older than the window, then count occurrences of *this* signature.
		const cutoff = nowMs - t.config.window_seconds * 1000;
		t.recent = t.recent.filter((f) => Date.parse(f.at) >= cutoff);
		// Already quarantined: keep the books accurate for in-flight events, but don't re-act.
		if (t.quarantined) return;
		const count = t.recent.filter((f) => f.signature === signature).length;
		if (count < t.config.same_failure_threshold) return;
		t.quarantined = true;
		await this.actions.quarantine(name);
	}
}
