import { createWriteStream, openSync, renameSync, statSync, type WriteStream } from "node:fs";
import { mkdir, readdir, rm } from "node:fs/promises";
import { join } from "node:path";

/**
 * The rotation-aware writer behind a service's chronicle (`logs/<name>.jsonl`), ADR 0008.
 *
 * The live file always keeps the documented path `logs/<name>.jsonl`. Its contents roll to a
 * **dated archive** when either (a) the calendar day changes, or (b) a size safety-cap is crossed:
 *
 *   logs/<name>.jsonl                     # today, live
 *   logs/<name>.2026-06-04.jsonl          # a day-roll archive
 *   logs/<name>.2026-06-04T14-30-02.jsonl # a mid-day size-roll archive (full hyphenated timestamp)
 *
 * Rotation is **pid-native**: pi has no rotation because it segments per session, but pid's services
 * are one long-lived process spanning many sessions over days, so pid must segment by time instead.
 * The dated-archive naming stays congruent with pi's session-filename idiom (ISO, `:`/`.`→`-`).
 *
 * A roll runs **synchronously**: because JS is single-threaded, no write can interleave a roll, so we
 * can `rename` the live file and swap in a fresh stream in one tick — no async queue. The old stream's
 * fd keeps flushing its buffered tail into the now-renamed archive inode (correct — that tail belongs
 * to the archive); new writes land in the fresh live file. Rolls happen ~once a day, so the brief
 * blocking `rename`+reopen is negligible.
 */
export interface RotatingLogWriterOptions {
	/** Drop dated archives older than this many days (default 30). */
	retentionDays?: number;
	/** Roll the live file to an archive once it would exceed this many bytes (default 50 MiB). */
	sizeCapBytes?: number;
	/** Injectable clock — tests advance it to exercise the day-roll without waiting for midnight. */
	now?: () => Date;
}

const DEFAULT_RETENTION_DAYS = 30;
const DEFAULT_SIZE_CAP_BYTES = 50 * 1024 * 1024;

/** Local-calendar day `YYYY-MM-DD` — the unit a daily segment accumulates. Local (not UTC) so it
 *  matches the operator's intuition of "last night's run". */
function dayOf(d: Date): string {
	const y = d.getFullYear();
	const m = String(d.getMonth() + 1).padStart(2, "0");
	const day = String(d.getDate()).padStart(2, "0");
	return `${y}-${m}-${day}`;
}

/** `HH-mm-ss` (hyphenated, filename-safe) — disambiguates multiple size-rolls within one day. */
function timeOf(d: Date): string {
	const h = String(d.getHours()).padStart(2, "0");
	const m = String(d.getMinutes()).padStart(2, "0");
	const s = String(d.getSeconds()).padStart(2, "0");
	return `${h}-${m}-${s}`;
}

export class RotatingLogWriter {
	private stream: WriteStream;
	/** The calendar day the live file is currently accumulating (drives the day-roll check). */
	private day: string;
	/** Bytes written to the live file so far (drives the size-cap check). */
	private bytes: number;
	private closed = false;

	private constructor(
		private readonly dir: string,
		private readonly name: string,
		private readonly retentionDays: number,
		private readonly sizeCapBytes: number,
		private readonly now: () => Date,
		day: string,
		bytes: number,
	) {
		this.day = day;
		this.bytes = bytes;
		this.stream = this.openLive();
	}

	/**
	 * Open (or re-open, append-mode) a service's chronicle. If a live file from a previous day is
	 * already present, its day is seeded from the file's mtime so the very first write rolls it to the
	 * correct dated archive (the normal day-roll path handles it — no special startup case).
	 */
	static async open(dir: string, name: string, opts: RotatingLogWriterOptions = {}): Promise<RotatingLogWriter> {
		await mkdir(dir, { recursive: true });
		const now = opts.now ?? (() => new Date());
		const livePath = join(dir, `${name}.jsonl`);
		let day = dayOf(now());
		let bytes = 0;
		try {
			const st = statSync(livePath);
			if (st.size > 0) {
				// Existing content belongs to the day it was last written, not "today".
				day = dayOf(st.mtime);
				bytes = st.size;
			}
		} catch {
			// No live file yet — start fresh on today's segment.
		}
		return new RotatingLogWriter(
			dir,
			name,
			opts.retentionDays ?? DEFAULT_RETENTION_DAYS,
			opts.sizeCapBytes ?? DEFAULT_SIZE_CAP_BYTES,
			now,
			day,
			bytes,
		);
	}

	private livePath(): string {
		return join(this.dir, `${this.name}.jsonl`);
	}

	private openLive(): WriteStream {
		// Open the fd synchronously (`a` creates the file at once) and hand it to the stream, so the
		// live file always exists on disk the instant a roll might `renameSync` it — `createWriteStream`
		// alone opens its fd asynchronously, which races an immediate roll into an ENOENT rename.
		const fd = openSync(this.livePath(), "a");
		const s = createWriteStream(this.livePath(), { fd });
		// Swallow + log write errors (e.g. disk full) so they can't crash the daemon as an unhandled
		// 'error' event. Sidecar-guarded so a stale handler from a rolled-away stream stays quiet.
		s.on("error", (err) => {
			if (this.stream !== s) return;
			process.stderr.write(`[${this.name}] log write error: ${err.message}\n`);
		});
		return s;
	}

	/** Append one already-serialized, newline-terminated line, rolling first if the day/size demands it. */
	write(line: string): void {
		if (this.closed) return;
		this.maybeRoll(Buffer.byteLength(line));
		this.stream.write(line);
		this.bytes += Buffer.byteLength(line);
	}

	/** Roll the live file to a dated archive when the day changed, or the next write would breach the cap. */
	private maybeRoll(nextLen: number): void {
		const today = dayOf(this.now());
		const dayChanged = today !== this.day;
		const sizeBreached = this.bytes > 0 && this.bytes + nextLen > this.sizeCapBytes;
		if (!dayChanged && !sizeBreached) return;

		// A day-roll archives under the *old* day; a mid-day size-roll adds a time suffix to stay unique.
		const stamp = dayChanged && !sizeBreached ? this.day : `${this.day}T${timeOf(this.now())}`;
		const archivePath = this.uniqueArchivePath(stamp);

		const old = this.stream;
		renameSync(this.livePath(), archivePath); // old fd now writes its buffered tail into the archive
		this.day = today;
		this.bytes = 0;
		this.stream = this.openLive(); // fresh live file for new writes
		old.end(); // flush + close the archived stream on its own

		void this.prune();
	}

	/** Avoid clobbering an existing archive (two size-rolls in the same second): suffix `-1`, `-2`, … */
	private uniqueArchivePath(stamp: string): string {
		let candidate = join(this.dir, `${this.name}.${stamp}.jsonl`);
		let n = 1;
		while (existsSyncSafe(candidate)) {
			candidate = join(this.dir, `${this.name}.${stamp}-${n}.jsonl`);
			n += 1;
		}
		return candidate;
	}

	/** Delete dated archives older than the retention window. Best-effort: errors are logged, not thrown. */
	private async prune(): Promise<void> {
		try {
			const cutoff = new Date(this.now());
			cutoff.setDate(cutoff.getDate() - this.retentionDays);
			const cutoffDay = dayOf(cutoff);
			const entries = await readdir(this.dir);
			const prefix = `${this.name}.`;
			await Promise.all(
				entries.map(async (entry) => {
					if (!entry.startsWith(prefix) || entry === `${this.name}.jsonl`) return;
					// Archive names are `<name>.<YYYY-MM-DD>[...].jsonl` — the day is the first 10 chars.
					const tail = entry.slice(prefix.length);
					const day = tail.slice(0, 10);
					if (!/^\d{4}-\d{2}-\d{2}$/.test(day)) return;
					if (day < cutoffDay) await rm(join(this.dir, entry), { force: true });
				}),
			);
		} catch (err) {
			process.stderr.write(`[${this.name}] log prune failed: ${err instanceof Error ? err.message : String(err)}\n`);
		}
	}

	/** Close the live stream. Idempotent; further writes no-op. Mirrors the old `WriteStream.end()` call. */
	end(): void {
		if (this.closed) return;
		this.closed = true;
		this.stream.end();
	}
}

function existsSyncSafe(path: string): boolean {
	try {
		statSync(path);
		return true;
	} catch {
		return false;
	}
}
