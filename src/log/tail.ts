import { closeSync, openSync, readSync, statSync, unwatchFile, watchFile } from "node:fs";
import { StringDecoder } from "node:string_decoder";

/**
 * Follow one live chronicle file, emitting each newly-appended line (ADR 0008 `-f`). pi has no
 * tail idiom to mirror (it re-reads whole session files), so this is pid-native — but it reuses pi's
 * LF line-framing (split on `\n`, strip a trailing `\r`).
 *
 * Polling (`watchFile`) rather than `fs.watch`: boring and cross-platform, and it sidesteps
 * `fs.watch`'s flaky rename/inode behaviour at the midnight roll. Rotation is handled by re-stat'ing
 * the *path* each tick — when the live file is replaced its size drops below our offset, so we reset
 * to 0 and read the fresh file (`tail -F` semantics). Lines written to the old file in the moment
 * before a roll land in the archive and are read via `pid logs`, not here — an accepted live-tail edge.
 */
export interface FileTailerOptions {
	/** Emit the file's existing content before following (default: false — only new appends). */
	fromStart?: boolean;
	/** Poll interval in ms (default 200). */
	intervalMs?: number;
}

export class FileTailer {
	private offset = 0;
	private buffer = "";
	private readonly decoder = new StringDecoder("utf8");
	private readonly intervalMs: number;
	private readonly fromStart: boolean;
	private started = false;

	constructor(
		private readonly path: string,
		private readonly onLine: (raw: string) => void,
		opts: FileTailerOptions = {},
	) {
		this.intervalMs = opts.intervalMs ?? 200;
		this.fromStart = opts.fromStart ?? false;
	}

	/** Begin following. Reads any pre-existing content first only when `fromStart` is set. */
	start(): void {
		if (this.started) return;
		this.started = true;
		try {
			this.offset = this.fromStart ? 0 : statSync(this.path).size;
		} catch {
			this.offset = 0; // file not created yet — start from the top once it appears
		}
		this.poll(); // catch content already past the initial offset
		watchFile(this.path, { interval: this.intervalMs }, () => this.poll());
	}

	/** Stop following and release the watcher. */
	stop(): void {
		if (!this.started) return;
		unwatchFile(this.path);
		this.started = false;
	}

	private poll(): void {
		let size: number;
		try {
			size = statSync(this.path).size;
		} catch {
			return; // briefly absent mid-rotation; next tick picks up the fresh file
		}
		if (size < this.offset) {
			// The live file was replaced (rotation) or truncated — restart from the new file's top.
			this.offset = 0;
			this.buffer = "";
		}
		if (size <= this.offset) return;

		const fd = openSync(this.path, "r");
		try {
			const len = size - this.offset;
			const buf = Buffer.allocUnsafe(len);
			const read = readSync(fd, buf, 0, len, this.offset);
			this.offset += read;
			this.buffer += this.decoder.write(buf.subarray(0, read));
		} finally {
			closeSync(fd);
		}

		let nl = this.buffer.indexOf("\n");
		while (nl !== -1) {
			const line = this.buffer.slice(0, nl);
			this.buffer = this.buffer.slice(nl + 1);
			const raw = line.endsWith("\r") ? line.slice(0, -1) : line;
			if (raw) this.onLine(raw);
			nl = this.buffer.indexOf("\n");
		}
	}
}
