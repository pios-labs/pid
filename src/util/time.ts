/**
 * Calendar-window math for budget enforcement (see ADR 0002).
 *
 * Budget windows are calendar-aligned in a configurable IANA time zone: a daily
 * window runs from local midnight to local midnight; a weekly window from Monday
 * 00:00 to the next Monday 00:00. Because zones observe DST, a calendar day is
 * not always 24h — so boundaries are computed from wall-clock midnight in the
 * zone, never by adding a fixed 86_400_000 ms.
 *
 * Implemented with the built-in Intl/ICU only — no extra dependency.
 */

/** Monday, in the 0=Sunday..6=Saturday convention (ISO week start). */
const MONDAY = 1;

export interface Window {
	start: Date;
	end: Date;
}

/** Throw if `tz` is not a valid IANA time zone. Cheap fail-fast for config load. */
export function assertValidTimeZone(tz: string): void {
	try {
		new Intl.DateTimeFormat("en-US", { timeZone: tz });
	} catch {
		throw new Error(`invalid time zone: ${tz}`);
	}
}

/** Offset of `tz` from UTC, in ms, at instant `date` (positive = ahead of UTC). */
function tzOffsetMs(tz: string, date: Date): number {
	const dtf = new Intl.DateTimeFormat("en-US", {
		timeZone: tz,
		hourCycle: "h23",
		year: "numeric",
		month: "2-digit",
		day: "2-digit",
		hour: "2-digit",
		minute: "2-digit",
		second: "2-digit",
	});
	const parts = dtf.formatToParts(date);
	const get = (type: string) => Number(parts.find((p) => p.type === type)?.value);
	const asUtc = Date.UTC(get("year"), get("month") - 1, get("day"), get("hour"), get("minute"), get("second"));
	return asUtc - date.getTime();
}

/**
 * UTC instant of local midnight (00:00:00) on calendar date y-m-d in `tz`.
 * `m` is 1-based; `d` may overflow or go negative (Date.UTC normalizes it).
 */
function zonedMidnightUtc(y: number, m: number, d: number, tz: string): Date {
	const guess = Date.UTC(y, m - 1, d, 0, 0, 0);
	// The zone offset at the guessed instant; subtract it to land on the real UTC instant of that wall time.
	const offset = tzOffsetMs(tz, new Date(guess));
	let ts = guess - offset;
	// Re-evaluate at the corrected instant: across a DST boundary the offset can differ, and the
	// corrected instant is the authoritative one for that wall-clock midnight.
	const offset2 = tzOffsetMs(tz, new Date(ts));
	if (offset2 !== offset) ts = guess - offset2;
	return new Date(ts);
}

/** Local calendar year/month(1-based)/day of instant `at` in `tz`. */
function localYmd(at: Date, tz: string): { y: number; m: number; d: number } {
	const dtf = new Intl.DateTimeFormat("en-US", { timeZone: tz, year: "numeric", month: "2-digit", day: "2-digit" });
	const parts = dtf.formatToParts(at);
	const get = (type: string) => Number(parts.find((p) => p.type === type)?.value);
	return { y: get("year"), m: get("month"), d: get("day") };
}

/** The calendar-day window (local midnight → next local midnight in `tz`) containing `at`. */
export function dayWindow(at: Date, tz: string): Window {
	const { y, m, d } = localYmd(at, tz);
	return { start: zonedMidnightUtc(y, m, d, tz), end: zonedMidnightUtc(y, m, d + 1, tz) };
}

/** The calendar-week window (Monday 00:00 → next Monday 00:00 in `tz`) containing `at`. */
export function weekWindow(at: Date, tz: string, weekStartsOn: number = MONDAY): Window {
	const { y, m, d } = localYmd(at, tz);
	// Day-of-week of the local calendar date (0=Sun..6=Sat) — fixed by the date, independent of tz.
	const dow = new Date(Date.UTC(y, m - 1, d)).getUTCDay();
	const daysFromStart = (dow - weekStartsOn + 7) % 7;
	return {
		start: zonedMidnightUtc(y, m, d - daysFromStart, tz),
		end: zonedMidnightUtc(y, m, d - daysFromStart + 7, tz),
	};
}

/** Local calendar date in `tz` as `YYYY-MM-DD` — used for budget history keys. */
export function localDateKey(at: Date, tz: string): string {
	const { y, m, d } = localYmd(at, tz);
	return `${y}-${String(m).padStart(2, "0")}-${String(d).padStart(2, "0")}`;
}
