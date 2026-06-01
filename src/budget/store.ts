import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { budgetDir } from "../util/paths.js";
import { dayWindow, localDateKey, weekWindow } from "../util/time.js";

/**
 * Per-service budget accounting, persisted to `~/.pi/pid/budget/<name>.json`
 * (see ADR 0002). Mirrors StateStore's atomic tmp+rename writes.
 *
 * Holds two calendar-aligned windows: a daily window (drives `daily_usd` and
 * `daily_tokens`) and a weekly window (drives `weekly_usd`). Window boundaries
 * come from `util/time.ts` (calendar-aligned in the service's `reset_tz`,
 * DST-correct). This layer only *accumulates and rolls* — deciding whether a cap
 * is breached belongs to the governor, which holds the caps.
 *
 * Tokens are the four-component sum (input+output+cacheRead+cacheWrite); the
 * caller passes the already-summed value (ADR 0002).
 */

/** Keep at most this many archived daily entries, newest last. */
const HISTORY_LIMIT = 30;

interface DayWindowState {
	start: string;
	end: string;
	spent_usd: number;
	tokens: number;
}

interface WeekWindowState {
	start: string;
	end: string;
	spent_usd: number;
}

interface HistoryEntry {
	date: string;
	spent_usd: number;
	tokens: number;
}

/**
 * Window-scoped manual override of the configured caps (ADR 0002, `pid resume`).
 * Each entry: a number raises/lowers that dimension's ceiling; `null` lifts it
 * (unlimited); absent means "use the configured cap". Daily entries expire when
 * the daily window rolls, the weekly entry when the weekly window rolls — so an
 * override only ever loosens (or tightens) the *current* window, then evaporates.
 */
export interface OverrideState {
	daily_usd?: number | null;
	daily_tokens?: number | null;
	weekly_usd?: number | null;
}

interface BudgetState {
	version: 1;
	service: string;
	day?: DayWindowState;
	week?: WeekWindowState;
	override?: OverrideState;
	/** Archived daily windows (weekly history is not retained in v0 — see ADR 0002 deferrals). */
	history: HistoryEntry[];
}

/** A per-message usage delta to charge against the windows. */
export interface UsageDelta {
	costUsd: number;
	tokens: number;
}

/** Current accumulators plus the window ends (used by the governor for breach checks and resume timing). */
export interface BudgetSnapshot {
	spentUsdDay: number;
	spentUsdWeek: number;
	tokensDay: number;
	dayEnd: Date;
	weekEnd: Date;
	/** Active window-scoped override, if any (the governor folds it into the effective caps). */
	override?: OverrideState;
}

function within(at: Date, startIso: string, endIso: string): boolean {
	const t = at.getTime();
	return t >= Date.parse(startIso) && t < Date.parse(endIso);
}

export class BudgetStore {
	private constructor(
		private readonly path: string,
		private state: BudgetState,
	) {}

	static async open(service: string): Promise<BudgetStore> {
		const path = join(budgetDir(), `${service}.json`);
		let state: BudgetState;
		try {
			state = JSON.parse(await readFile(path, "utf8")) as BudgetState;
		} catch (err) {
			if ((err as NodeJS.ErrnoException).code === "ENOENT") {
				state = { version: 1, service, history: [] };
			} else {
				throw err;
			}
		}
		return new BudgetStore(path, state);
	}

	/** Roll any expired windows relative to `at`, then charge the delta. Returns the post-charge snapshot. */
	async record(delta: UsageDelta, at: Date, tz: string): Promise<BudgetSnapshot> {
		const { day, week } = this.ensureWindows(at, tz);
		day.spent_usd += delta.costUsd;
		day.tokens += delta.tokens;
		week.spent_usd += delta.costUsd;
		await this.persist();
		return toSnapshot(day, week, this.state.override);
	}

	/** Roll any expired windows relative to `at` without charging (boot recovery / status). */
	async refresh(at: Date, tz: string): Promise<BudgetSnapshot> {
		const { day, week, changed } = this.ensureWindows(at, tz);
		if (changed) await this.persist();
		return toSnapshot(day, week, this.state.override);
	}

	/** Force a fresh daily + weekly window anchored at `at` (the `--reset` / `budget reset` path). */
	async reset(at: Date, tz: string): Promise<void> {
		if (this.state.day && (this.state.day.spent_usd > 0 || this.state.day.tokens > 0)) {
			this.archive(this.state.day, tz);
		}
		const d = dayWindow(at, tz);
		const w = weekWindow(at, tz);
		this.state.day = { start: d.start.toISOString(), end: d.end.toISOString(), spent_usd: 0, tokens: 0 };
		this.state.week = { start: w.start.toISOString(), end: w.end.toISOString(), spent_usd: 0 };
		// A reset starts the window clean; any prior override no longer applies.
		this.state.override = undefined;
		await this.persist();
	}

	/**
	 * Merge `spec` into the active override (per-dimension; `undefined` keys leave that dimension
	 * unchanged, an explicit value or `null` sets it). First rolls expired windows so the override
	 * attaches to the current ones. Returns the post-merge snapshot.
	 */
	async setOverride(spec: OverrideState, at: Date, tz: string): Promise<BudgetSnapshot> {
		const { day, week } = this.ensureWindows(at, tz);
		const current = this.state.override ?? {};
		const merged: OverrideState = { ...current };
		for (const key of ["daily_usd", "daily_tokens", "weekly_usd"] as const) {
			if (key in spec) merged[key] = spec[key];
		}
		this.state.override = merged;
		await this.persist();
		return toSnapshot(day, week, this.state.override);
	}

	/**
	 * Re-anchor the day/week windows to the ones containing `at`, rolling (and archiving)
	 * any that have expired. Returns the now-guaranteed concrete windows.
	 */
	private ensureWindows(at: Date, tz: string): { day: DayWindowState; week: WeekWindowState; changed: boolean } {
		let changed = false;

		let day = this.state.day;
		if (!day || !within(at, day.start, day.end)) {
			if (day && (day.spent_usd > 0 || day.tokens > 0)) this.archive(day, tz);
			const w = dayWindow(at, tz);
			day = { start: w.start.toISOString(), end: w.end.toISOString(), spent_usd: 0, tokens: 0 };
			this.state.day = day;
			// The daily window rolled: daily overrides applied only to the old window.
			changed = this.clearOverride(["daily_usd", "daily_tokens"]) || true;
		}

		let week = this.state.week;
		if (!week || !within(at, week.start, week.end)) {
			const w = weekWindow(at, tz);
			week = { start: w.start.toISOString(), end: w.end.toISOString(), spent_usd: 0 };
			this.state.week = week;
			// The weekly window rolled: the weekly override applied only to the old window.
			changed = this.clearOverride(["weekly_usd"]) || true;
		}

		return { day, week, changed };
	}

	/** Drop the named override dimensions; returns whether anything was actually removed. */
	private clearOverride(keys: Array<keyof OverrideState>): boolean {
		const o = this.state.override;
		if (!o) return false;
		let removed = false;
		for (const key of keys) {
			if (key in o) {
				delete o[key];
				removed = true;
			}
		}
		if (Object.keys(o).length === 0) this.state.override = undefined;
		return removed;
	}

	private archive(day: DayWindowState, tz: string): void {
		this.state.history.push({
			date: localDateKey(new Date(day.start), tz),
			spent_usd: day.spent_usd,
			tokens: day.tokens,
		});
		if (this.state.history.length > HISTORY_LIMIT) {
			this.state.history = this.state.history.slice(-HISTORY_LIMIT);
		}
	}

	private async persist(): Promise<void> {
		await mkdir(budgetDir(), { recursive: true });
		const tmp = `${this.path}.tmp`;
		await writeFile(tmp, JSON.stringify(this.state, null, 2), "utf8");
		await rename(tmp, this.path);
	}
}

function toSnapshot(day: DayWindowState, week: WeekWindowState, override?: OverrideState): BudgetSnapshot {
	return {
		spentUsdDay: day.spent_usd,
		spentUsdWeek: week.spent_usd,
		tokensDay: day.tokens,
		dayEnd: new Date(day.end),
		weekEnd: new Date(week.end),
		...(override ? { override } : {}),
	};
}
