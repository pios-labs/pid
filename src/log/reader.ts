import { createReadStream } from "node:fs";
import { readdir } from "node:fs/promises";
import { join } from "node:path";
import { attachJsonlReader } from "../util/jsonl.js";
import type { LogEnvelope } from "../util/log.js";

/**
 * The daemon-free chronicle reader (ADR 0008): `pid logs` / the dashboard read the on-disk segments
 * directly. A service's history is the dated archives (ADR 0008 rotation) followed by the live file;
 * this module lists them in chronological order and streams their lines through a filter.
 */

export interface LogFilter {
	/** Keep only lines at/after this instant (compared against the envelope `ts`). */
	since?: Date;
	/** Keep only this event type. */
	type?: string;
	/** Keep only this source. */
	source?: "pi" | "pid";
}

/**
 * Parse a `--since` value: a relative age (`30s`/`15m`/`2h`/`7d`) measured back from `now`, or an
 * absolute ISO timestamp. Throws with a helpful hint on anything else.
 */
export function parseSince(value: string, now: Date): Date {
	const rel = /^(\d+)\s*([smhd])$/.exec(value.trim());
	if (rel) {
		const n = Number(rel[1]);
		const ms = { s: 1_000, m: 60_000, h: 3_600_000, d: 86_400_000 }[rel[2] as "s" | "m" | "h" | "d"];
		return new Date(now.getTime() - n * ms);
	}
	const t = Date.parse(value);
	if (Number.isNaN(t)) throw new Error(`invalid --since: "${value}" (use e.g. 30m, 2h, 7d, or an ISO timestamp)`);
	return new Date(t);
}

/**
 * A service's chronicle segments, oldest first, ending with the live file.
 *
 * Archive names are `<name>.<date>.jsonl` (a day-roll) or `<name>.<date>T<hh-mm-ss>[-N].jsonl` (a
 * mid-day size-roll). A plain `<date>` archive holds the *tail* of that day (it rolled at midnight,
 * after any intraday size-rolls), so it must sort **after** the same day's `T<time>` archives — hence
 * the `T99-99-99` sort key for plain dates. (`.gz` archives are skipped until gzip ships, ADR 0008.)
 */
export async function listSegments(dir: string, name: string): Promise<string[]> {
	let entries: string[];
	try {
		entries = await readdir(dir);
	} catch {
		return []; // no logs dir yet
	}
	const live = `${name}.jsonl`;
	const prefix = `${name}.`;
	const archives = entries
		.filter((e) => e !== live && e.startsWith(prefix) && e.endsWith(".jsonl"))
		.map((e) => ({ file: e, key: archiveSortKey(e.slice(prefix.length, -".jsonl".length)) }))
		.sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0))
		.map((a) => join(dir, a.file));
	if (entries.includes(live)) archives.push(join(dir, live));
	return archives;
}

/** Plain `<date>` archives are the day's tail → sort after that day's intraday `T<time>` archives. */
function archiveSortKey(tail: string): string {
	return /^\d{4}-\d{2}-\d{2}$/.test(tail) ? `${tail}T99-99-99` : tail;
}

/** Whether an envelope passes a filter — shared by the history scan and the live follow path. */
export function matchesFilter(env: LogEnvelope, filter: LogFilter): boolean {
	if (filter.type && env.type !== filter.type) return false;
	if (filter.source && env.source !== filter.source) return false;
	if (filter.since && Date.parse(env.ts) < filter.since.getTime()) return false;
	return true;
}

/**
 * Stream a service's whole chronicle (all segments, in order) through `onEnvelope`, applying `filter`.
 * Reads line-by-line so memory stays flat regardless of history size; a malformed log line is skipped.
 */
export async function readChronicle(
	dir: string,
	name: string,
	filter: LogFilter,
	onEnvelope: (env: LogEnvelope) => void,
): Promise<void> {
	for (const segment of await listSegments(dir, name)) {
		await readSegment(segment, (env) => {
			if (matchesFilter(env, filter)) onEnvelope(env);
		});
	}
}

/** Read one segment file as JSONL envelopes, reusing pi's LF line-framing (`attachJsonlReader`). */
function readSegment(path: string, onEnvelope: (env: LogEnvelope) => void): Promise<void> {
	return new Promise((resolve, reject) => {
		const stream = createReadStream(path);
		const detach = attachJsonlReader<LogEnvelope>(
			stream,
			onEnvelope,
			() => {}, // a corrupt line in our own log: skip it, keep reading
		);
		stream.on("end", () => {
			detach();
			resolve();
		});
		stream.on("error", (err) => {
			detach();
			reject(err);
		});
	});
}
