import type { BudgetSnapshot, BudgetStore, OverrideState } from "../budget/store.js";
import type { ServiceConfig } from "../services/schema.js";

/**
 * Cost governor (see ADR 0002): the first consumer behind the supervisor's
 * onServiceEvent seam. It charges each assistant message's cost/tokens against
 * the per-service BudgetStore, and on a cap breach either pauses the service
 * (graceful stop, resume at the window reset) or — in notify mode — records the
 * breach and lets it run.
 *
 * Enforcement is necessarily reactive: cost arrives on message_end *after* the
 * spend, so the governor halts the next turn rather than the message that
 * crossed the line (inherent to pi's event model).
 *
 * The pause/resume actions go through the injected BudgetActions seam, so the
 * pause *mechanism* (today: stop()/start()) can change without touching this
 * module — the path to pause option B (ADR 0002).
 */

/** The budget block as it appears post-parse (on_exceed and reset_tz always present via defaults). */
export type BudgetConfig = NonNullable<ServiceConfig["budget"]>;

/** The supervisor capabilities the governor drives. Implemented in step 4 by the Supervisor. */
export interface BudgetActions {
	pause(name: string): Promise<void>;
	resume(name: string): Promise<void>;
	/** Append a documented `pid_budget_pause` event to the service's chronicle (ADR 0005). No-op if not running. */
	logBudgetPause(name: string, data: Record<string, unknown>): void;
	/** Append a documented `pid_budget_resume` event to the service's chronicle (ADR 0005). No-op if not running. */
	logBudgetResume(name: string, data: Record<string, unknown>): void;
}

/** A per-message charge, with the instant to attribute it to (message timestamp, or now). */
export interface ChargedUsage {
	costUsd: number;
	tokens: number;
	at: Date;
}

export type CapKind = "daily_usd" | "weekly_usd" | "daily_tokens";

export interface BreachedCap {
	cap: CapKind;
	limit: number;
	spent: number;
	/** End of the window this cap is measured over — used to time the resume. */
	windowEnd: Date;
}

export interface BudgetStatus {
	paused: boolean;
	breachedCaps: BreachedCap[] | null;
}

export type TimerHandle = unknown;

/** Injectable timer service so resume scheduling is deterministic under test. */
export interface TimerService {
	set(fn: () => void, ms: number): TimerHandle;
	clear(handle: TimerHandle): void;
}

export interface CostGovernorOptions {
	actions: BudgetActions;
	now?: () => number;
	timers?: TimerService;
}

const defaultTimers: TimerService = {
	set: (fn, ms) => setTimeout(fn, ms),
	clear: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
};

/**
 * Pull the chargeable usage from an event, or null if it isn't an assistant
 * `message_end` carrying usage. Defensive against malformed lines (pid consumes
 * an external stream). Tokens are the four-component sum (ADR 0002), and the
 * charge instant is the message timestamp when present, else `fallbackNow`.
 */
export function extractUsage(event: unknown, fallbackNow: number): ChargedUsage | null {
	if (typeof event !== "object" || event === null) return null;
	const ev = event as Record<string, unknown>;
	if (ev.type !== "message_end") return null;

	const msg = ev.message as Record<string, unknown> | undefined;
	if (!msg || msg.role !== "assistant") return null;

	const usage = msg.usage as Record<string, unknown> | undefined;
	if (!usage) return null;
	const cost = usage.cost as Record<string, unknown> | undefined;
	if (
		typeof usage.input !== "number" ||
		typeof usage.output !== "number" ||
		typeof usage.cacheRead !== "number" ||
		typeof usage.cacheWrite !== "number" ||
		!cost ||
		typeof cost.total !== "number"
	) {
		return null;
	}

	const ts = typeof msg.timestamp === "number" ? msg.timestamp : fallbackNow;
	return {
		costUsd: cost.total,
		tokens: usage.input + usage.output + usage.cacheRead + usage.cacheWrite,
		at: new Date(ts),
	};
}

/**
 * Fold a window-scoped override into the configured caps to get the *effective* caps for breach
 * checks (ADR 0002). Per dimension: a number replaces the cap, `null` lifts it (unlimited →
 * undefined), absent leaves the configured value. Overrides are independent — lifting `daily_usd`
 * leaves `weekly_usd` in force, so a daily lift still re-pauses when the weekly guardrail is hit.
 */
export function applyOverride(caps: BudgetConfig, override?: BudgetSnapshot["override"]): BudgetConfig {
	if (!override) return caps;
	const effective = { ...caps };
	for (const key of ["daily_usd", "daily_tokens", "weekly_usd"] as const) {
		if (key in override) {
			const value = override[key];
			if (value === null) delete effective[key];
			else effective[key] = value;
		}
	}
	return effective;
}

/** Which configured caps the snapshot has reached or exceeded. Empty = within budget. */
export function evaluateBreach(snap: BudgetSnapshot, caps: BudgetConfig): BreachedCap[] {
	const breached: BreachedCap[] = [];
	if (caps.daily_usd !== undefined && snap.spentUsdDay >= caps.daily_usd) {
		breached.push({ cap: "daily_usd", limit: caps.daily_usd, spent: snap.spentUsdDay, windowEnd: snap.dayEnd });
	}
	if (caps.weekly_usd !== undefined && snap.spentUsdWeek >= caps.weekly_usd) {
		breached.push({ cap: "weekly_usd", limit: caps.weekly_usd, spent: snap.spentUsdWeek, windowEnd: snap.weekEnd });
	}
	if (caps.daily_tokens !== undefined && snap.tokensDay >= caps.daily_tokens) {
		breached.push({ cap: "daily_tokens", limit: caps.daily_tokens, spent: snap.tokensDay, windowEnd: snap.dayEnd });
	}
	return breached;
}

interface Tracked {
	caps: BudgetConfig;
	store: BudgetStore;
	paused: boolean;
	lastBreach: BreachedCap[] | null;
	resumeHandle: TimerHandle | null;
	/** Serializes charges per service so concurrent events can't interleave read-modify-write. */
	queue: Promise<void>;
}

export class CostGovernor implements BudgetActions {
	private readonly actions: BudgetActions;
	private readonly now: () => number;
	private readonly timers: TimerService;
	private readonly tracked = new Map<string, Tracked>();

	constructor(opts: CostGovernorOptions) {
		this.actions = opts.actions;
		this.now = opts.now ?? Date.now;
		this.timers = opts.timers ?? defaultTimers;
	}

	// CostGovernor implements BudgetActions only so the type travels cleanly; it delegates.
	pause(name: string): Promise<void> {
		return this.actions.pause(name);
	}
	resume(name: string): Promise<void> {
		return this.actions.resume(name);
	}
	logBudgetPause(name: string, data: Record<string, unknown>): void {
		this.actions.logBudgetPause(name, data);
	}
	logBudgetResume(name: string, data: Record<string, unknown>): void {
		this.actions.logBudgetResume(name, data);
	}

	/** Start tracking a budgeted service. The caller owns opening the BudgetStore. */
	register(name: string, caps: BudgetConfig, store: BudgetStore): void {
		this.tracked.set(name, {
			caps,
			store,
			paused: false,
			lastBreach: null,
			resumeHandle: null,
			queue: Promise.resolve(),
		});
	}

	/** Handle one parsed subprocess event. No-op for non-budgeted services and non-usage events. */
	handleEvent(name: string, event: unknown): Promise<void> {
		const t = this.tracked.get(name);
		if (!t) return Promise.resolve();
		const usage = extractUsage(event, this.now());
		if (!usage) return Promise.resolve();
		t.queue = t.queue
			.then(() => this.charge(name, t, usage))
			.catch((err) => {
				process.stderr.write(`[${name}] governor charge failed: ${err instanceof Error ? err.message : String(err)}\n`);
			});
		return t.queue;
	}

	/**
	 * Reconcile on daemon boot: roll any expired windows, and if a budgeted service is still over
	 * a cap, re-establish the paused state and re-arm its resume timer. Returns whether the service
	 * should remain held (the boot path skips starting it) vs. is clear to start.
	 */
	async recover(name: string): Promise<{ stillPaused: boolean }> {
		const t = this.tracked.get(name);
		if (!t) return { stillPaused: false };
		const snap = await t.store.refresh(new Date(this.now()), t.caps.reset_tz);
		const breached = evaluateBreach(snap, applyOverride(t.caps, snap.override));
		if (breached.length > 0 && t.caps.on_exceed === "pause") {
			t.paused = true;
			t.lastBreach = breached;
			this.armResume(name, t, breached);
			return { stillPaused: true };
		}
		return { stillPaused: false };
	}

	status(name: string): BudgetStatus | undefined {
		const t = this.tracked.get(name);
		if (!t) return undefined;
		return { paused: t.paused, breachedCaps: t.lastBreach };
	}

	/**
	 * Cancel a pending resume and clear the paused bookkeeping — e.g. the user manually stopped
	 * a budget-paused service and we must not auto-resume it at the window reset.
	 */
	cancelResume(name: string): void {
		const t = this.tracked.get(name);
		if (!t) return;
		if (t.resumeHandle !== null) {
			this.timers.clear(t.resumeHandle);
			t.resumeHandle = null;
		}
		t.paused = false;
		t.lastBreach = null;
	}

	/**
	 * Stop tracking a service whose budget config was removed, or whose definition was removed on
	 * `pid reload` (ADR 0010). Cancels any pending resume timer first so it can't fire post-removal.
	 */
	unregister(name: string): void {
		this.cancelResume(name);
		this.tracked.delete(name);
	}

	/**
	 * Apply a manual budget override and resume the service (the `pid resume` path, ADR 0002).
	 *
	 * `spec` is a per-dimension override (number = new ceiling, null = unlimited, absent = leave
	 * as configured); `reset` instead zeroes the current windows and drops any override, putting
	 * the service back under its configured caps with a clean slate. Either way the service is
	 * un-paused and resumed — but only if the new effective caps clear the current spend, so a
	 * resume that is still over an un-overridden guardrail (e.g. weekly) immediately re-pauses.
	 */
	async override(name: string, spec: OverrideState, reset = false): Promise<void> {
		const t = this.tracked.get(name);
		if (!t) throw new Error(`unknown service: ${name}`);

		if (t.resumeHandle !== null) {
			this.timers.clear(t.resumeHandle);
			t.resumeHandle = null;
		}

		const at = new Date(this.now());
		let snap: BudgetSnapshot;
		if (reset) {
			await t.store.reset(at, t.caps.reset_tz);
			snap = await t.store.refresh(at, t.caps.reset_tz);
		} else {
			snap = await t.store.setOverride(spec, at, t.caps.reset_tz);
		}

		t.paused = false;
		t.lastBreach = null;
		await this.actions.resume(name);
		// The manual `pid resume` path: log after the start so the (now-open) stream captures it.
		this.actions.logBudgetResume(name, { by: "manual" });

		// If spend already exceeds the new effective caps (e.g. weekly still breached after lifting
		// daily), re-pause immediately so the surviving guardrail holds. The resume/pause pair tells
		// the whole story in the chronicle ("lifted, but weekly still over → held again").
		const breached = evaluateBreach(snap, applyOverride(t.caps, snap.override));
		if (breached.length > 0 && t.caps.on_exceed === "pause") {
			t.paused = true;
			t.lastBreach = breached;
			this.logPause(name, breached);
			await this.actions.pause(name);
			this.armResume(name, t, breached);
		}
	}

	/** Cancel every pending resume timer (daemon shutdown), so no timer outlives the process. */
	dispose(): void {
		for (const t of this.tracked.values()) {
			if (t.resumeHandle !== null) {
				this.timers.clear(t.resumeHandle);
				t.resumeHandle = null;
			}
		}
	}

	private async charge(name: string, t: Tracked, usage: ChargedUsage): Promise<void> {
		const snap = await t.store.record({ costUsd: usage.costUsd, tokens: usage.tokens }, usage.at, t.caps.reset_tz);
		// Already paused: keep the books accurate for any in-flight events, but don't re-act.
		if (t.paused) return;

		const breached = evaluateBreach(snap, applyOverride(t.caps, snap.override));
		if (breached.length === 0) return;
		t.lastBreach = breached;

		// notify: observe-only — record the breach, leave the service running.
		if (t.caps.on_exceed === "notify") return;

		// pause: stop the service and schedule resume at the reset of the latest breached window.
		t.paused = true;
		this.logPause(name, breached);
		await this.actions.pause(name);
		this.armResume(name, t, breached);
	}

	/**
	 * Emit the documented `pid_budget_pause` intervention event (ADR 0005). Called *before* the
	 * actual `pause()`/`stop()` so the service's log stream is still open. `resumeAt` matches
	 * `armResume`'s computation: the latest breached window's reset.
	 */
	private logPause(name: string, breached: BreachedCap[]): void {
		this.actions.logBudgetPause(name, {
			breached: breached.map((b) => ({
				cap: b.cap,
				limit: b.limit,
				spent: b.spent,
				windowEnd: b.windowEnd.toISOString(),
			})),
			resumeAt: new Date(Math.max(...breached.map((b) => b.windowEnd.getTime()))).toISOString(),
			by: "governor",
		});
	}

	private armResume(name: string, t: Tracked, breached: BreachedCap[]): void {
		// Resume only once *every* breached cap's window has rolled over (so a weekly breach
		// doesn't wrongly resume at the next daily midnight) — ADR 0002.
		const resumeAt = Math.max(...breached.map((b) => b.windowEnd.getTime()));
		const delay = Math.max(0, resumeAt - this.now());
		if (t.resumeHandle !== null) this.timers.clear(t.resumeHandle);
		t.resumeHandle = this.timers.set(() => {
			void this.doResume(name, t);
		}, delay);
	}

	private async doResume(name: string, t: Tracked): Promise<void> {
		t.paused = false;
		t.lastBreach = null;
		t.resumeHandle = null;
		await this.actions.resume(name);
		// The automatic window-reset resume: log after the start, so the reopened stream captures it.
		this.actions.logBudgetResume(name, { by: "timer" });
	}
}
