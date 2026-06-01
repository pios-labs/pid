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

interface BudgetState {
	version: 1;
	service: string;
	day?: DayWindowState;
	week?: WeekWindowState;
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
		return toSnapshot(day, week);
	}

	/** Roll any expired windows relative to `at` without charging (boot recovery / status). */
	async refresh(at: Date, tz: string): Promise<BudgetSnapshot> {
		const { day, week, changed } = this.ensureWindows(at, tz);
		if (changed) await this.persist();
		return toSnapshot(day, week);
	}

	/** Force a fresh daily + weekly window anchored at `at` (the `budget reset` command). */
	async reset(at: Date, tz: string): Promise<void> {
		if (this.state.day && (this.state.day.spent_usd > 0 || this.state.day.tokens > 0)) {
			this.archive(this.state.day, tz);
		}
		const d = dayWindow(at, tz);
		const w = weekWindow(at, tz);
		this.state.day = { start: d.start.toISOString(), end: d.end.toISOString(), spent_usd: 0, tokens: 0 };
		this.state.week = { start: w.start.toISOString(), end: w.end.toISOString(), spent_usd: 0 };
		await this.persist();
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
			changed = true;
		}

		let week = this.state.week;
		if (!week || !within(at, week.start, week.end)) {
			const w = weekWindow(at, tz);
			week = { start: w.start.toISOString(), end: w.end.toISOString(), spent_usd: 0 };
			this.state.week = week;
			changed = true;
		}

		return { day, week, changed };
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

function toSnapshot(day: DayWindowState, week: WeekWindowState): BudgetSnapshot {
	return {
		spentUsdDay: day.spent_usd,
		spentUsdWeek: week.spent_usd,
		tokensDay: day.tokens,
		dayEnd: new Date(day.end),
		weekEnd: new Date(week.end),
	};
}
