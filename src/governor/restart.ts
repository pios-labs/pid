import type { ServiceConfig } from "../services/schema.js";
import type { TimerHandle, TimerService } from "./cost.js";

/**
 * Restart relauncher (ADR 0013): the third supervision module behind the supervisor, alongside the
 * cost governor and crash detector. It owns the `restart:` policy — re-spawning a service that exits
 * unexpectedly, with exponential backoff, and giving up after `max_consecutive` rapid failures so a
 * flapping service doesn't loop forever.
 *
 * Like the governor, the decision is a pure, injectable core (timers + the re-spawn action are
 * injected) so the policy/backoff/give-up matrix is unit-tested deterministically; the supervisor
 * owns the I/O — classifying the exit, feeding the crash detector, and logging the `pid_restart`
 * event to the still-open chronicle (which is why `onExit` returns the decision rather than logging).
 *
 * Eligibility (ADR 0013): only an *unexpected* exit of a service that has reached `running` at least
 * once is relaunched. A deliberate stop (`cancel`) and a first start that never reaches running are
 * both excluded — the former must not fight the operator, the latter must fail loudly, not loop.
 */
export type RestartConfig = ServiceConfig["restart"];

/** The supervisor capability the relauncher drives: re-spawn the service. */
export interface RestartActions {
	start(name: string): Promise<void>;
}

/** What the supervisor observed about an exit, for the relaunch decision. */
export interface ExitObservation {
	/** A failure (non-zero code, external signal, spawn error) vs a clean self-exit (code 0). */
	failed: boolean;
	/** How long the service had been running before it exited (ms) — drives the stable-run reset. */
	uptimeMs: number;
}

export type RestartAction = "relaunch" | "give-up" | "none";

export interface RestartDecision {
	action: RestartAction;
	/** 1-based attempt number (relaunch), or the consecutive count reached (give-up). */
	attempt: number;
	max: number;
	/** Backoff before the armed relaunch fires (relaunch only). */
	delayMs: number;
}

const defaultTimers: TimerService = {
	set: (fn, ms) => setTimeout(fn, ms),
	clear: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
};

interface Tracked {
	config: RestartConfig;
	/** Reached `running` at least once since the last deliberate stop — the relaunch-eligibility gate. */
	started: boolean;
	/** Consecutive fast-failure relaunches with no intervening stable run. */
	consecutive: number;
	handle: TimerHandle | null;
}

export class Relauncher {
	private readonly actions: RestartActions;
	private readonly timers: TimerService;
	private readonly tracked = new Map<string, Tracked>();

	constructor(opts: { actions: RestartActions; timers?: TimerService }) {
		this.actions = opts.actions;
		this.timers = opts.timers ?? defaultTimers;
	}

	register(name: string, config: RestartConfig): void {
		const prev = this.tracked.get(name);
		if (prev?.handle != null) this.timers.clear(prev.handle);
		this.tracked.set(name, { config, started: false, consecutive: 0, handle: null });
	}

	unregister(name: string): void {
		this.cancel(name);
		this.tracked.delete(name);
	}

	/** The service reached `running`: mark it relaunch-eligible. */
	markStarted(name: string): void {
		const t = this.tracked.get(name);
		if (t) t.started = true;
	}

	/**
	 * Whether the service is relaunch-eligible — it reached `running` since its last deliberate stop.
	 * The supervisor uses this to gate both relaunch and proc-exit crash counting, so a service that
	 * never started (a misconfigured first `pid start`) is neither looped nor quarantined.
	 */
	isEligible(name: string): boolean {
		return this.tracked.get(name)?.started ?? false;
	}

	/**
	 * A deliberate stop (stop/pause/quarantine/shutdown/orphan) or a manual re-arm: cancel any pending
	 * relaunch, make the service ineligible until it next reaches running, and reset the flap counter.
	 */
	cancel(name: string): void {
		const t = this.tracked.get(name);
		if (!t) return;
		if (t.handle != null) {
			this.timers.clear(t.handle);
			t.handle = null;
		}
		t.started = false;
		t.consecutive = 0;
	}

	/**
	 * Decide what to do about an unexpected exit and arm the relaunch timer if relaunching. Pure except
	 * for arming the (injected) timer; returns the decision so the supervisor can log it to the chronicle
	 * before the log closes. `none` when ineligible or the policy declines; `give-up` at the flap cap.
	 */
	onExit(name: string, obs: ExitObservation): RestartDecision {
		const none: RestartDecision = { action: "none", attempt: 0, max: 0, delayMs: 0 };
		const t = this.tracked.get(name);
		if (!t || !t.started) return none;

		const { policy, max_consecutive, backoff } = t.config;
		// A run that outlived the longest backoff has recovered — clear the flap counter before deciding.
		if (obs.uptimeMs >= backoff.max_ms) t.consecutive = 0;

		const wants = policy === "always" || (policy === "on-failure" && obs.failed);
		if (!wants) return { ...none, max: max_consecutive };

		if (t.consecutive >= max_consecutive) {
			// Flapping backstop: stop relaunching, leave the service failed, require a fresh manual start.
			const attempt = t.consecutive;
			t.started = false;
			t.consecutive = 0;
			return { action: "give-up", attempt, max: max_consecutive, delayMs: 0 };
		}

		const attempt = t.consecutive + 1;
		const delayMs = Math.min(backoff.max_ms, Math.round(backoff.initial_ms * backoff.factor ** t.consecutive));
		t.consecutive = attempt;
		if (t.handle != null) this.timers.clear(t.handle);
		t.handle = this.timers.set(() => {
			t.handle = null;
			void this.actions.start(name).catch(() => {
				// A relaunch that fails to spawn drives the next onExit via finalizeExit — nothing to do here.
			});
		}, delayMs);
		return { action: "relaunch", attempt, max: max_consecutive, delayMs };
	}

	/** Cancel every pending relaunch timer (daemon shutdown), so none outlives the process. */
	dispose(): void {
		for (const t of this.tracked.values()) {
			if (t.handle != null) {
				this.timers.clear(t.handle);
				t.handle = null;
			}
		}
	}
}
