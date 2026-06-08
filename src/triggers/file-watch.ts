import { readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import type { ServiceConfig } from "../services/schema.js";
import { expandTilde } from "../util/paths.js";

/**
 * File-watch trigger (ADR 0014): the one native trigger pid owns, because "wake the agent when a file
 * lands" has no clean cross-platform OS primitive. On a matching filesystem event it launches a
 * one-shot supervised job (the supervisor's `launchJob`, fire-and-forget; overlapping fires are
 * skipped by launchJob's already-running guard).
 *
 * Polling, not `fs.watch` — the same choice ADR 0008 made for log tailing, and for the same reasons:
 * `fs.watch`'s rename/inode behaviour is flaky across platforms, whereas a periodic re-scan + diff is
 * boring and portable. The pure diff (`diffListings`) is unit-tested; the real fs scan is verified
 * against a live run (s12). The scanner and poll timer are injected so both are testable.
 */
export type FileWatchConfig = Extract<ServiceConfig["trigger"], { type: "file_watch" }>;
export type FsEventKind = "add" | "change" | "unlink";

/** A point-in-time listing of the watched path: entry name → mtime (ms). A missing path is empty. */
export type Listing = Map<string, number>;

export interface FileWatchActions {
	/** Launch the service's one-shot job (fire-and-forget). */
	fire(name: string): void;
}

/** Repeating poll timer, injectable for deterministic tests (default: setInterval). */
export interface PollTimer {
	set(fn: () => void, ms: number): unknown;
	clear(handle: unknown): void;
}

export interface FileWatchOptions {
	actions: FileWatchActions;
	scan?: (path: string) => Listing;
	timers?: PollTimer;
	intervalMs?: number;
}

/** Default scanner: a directory lists its entries (name→mtime); a file lists itself; a missing path is empty. */
export function defaultScan(path: string): Listing {
	const abs = expandTilde(path);
	const out: Listing = new Map();
	try {
		const st = statSync(abs);
		if (st.isDirectory()) {
			for (const name of readdirSync(abs)) {
				try {
					out.set(name, statSync(join(abs, name)).mtimeMs);
				} catch {
					// Entry vanished mid-scan (race) — treat as absent this round.
				}
			}
		} else {
			out.set(abs, st.mtimeMs);
		}
	} catch {
		// Missing path → empty listing (an `unlink` of the last entry, or not-yet-created).
	}
	return out;
}

/** Pure: which event kinds occurred between two listings (ADR 0014). */
export function diffListings(prev: Listing, curr: Listing): Set<FsEventKind> {
	const events = new Set<FsEventKind>();
	for (const [name, mtime] of curr) {
		if (!prev.has(name)) events.add("add");
		else if (prev.get(name) !== mtime) events.add("change");
	}
	for (const name of prev.keys()) {
		if (!curr.has(name)) events.add("unlink");
	}
	return events;
}

const defaultTimers: PollTimer = {
	set: (fn, ms) => setInterval(fn, ms),
	clear: (handle) => clearInterval(handle as ReturnType<typeof setInterval>),
};

const DEFAULT_INTERVAL_MS = 1000;

interface Tracked {
	config: FileWatchConfig;
	prev: Listing;
	handle: unknown;
}

export class FileWatchManager {
	private readonly actions: FileWatchActions;
	private readonly scan: (path: string) => Listing;
	private readonly timers: PollTimer;
	private readonly intervalMs: number;
	private readonly tracked = new Map<string, Tracked>();

	constructor(opts: FileWatchOptions) {
		this.actions = opts.actions;
		this.scan = opts.scan ?? defaultScan;
		this.timers = opts.timers ?? defaultTimers;
		this.intervalMs = opts.intervalMs ?? DEFAULT_INTERVAL_MS;
	}

	has(name: string): boolean {
		return this.tracked.has(name);
	}

	/** Arm (or re-arm) the watcher for a service. Idempotent: an unchanged config is a no-op, so a
	 * reload re-sync doesn't reset the baseline and spuriously re-fire. */
	register(name: string, config: FileWatchConfig): void {
		const existing = this.tracked.get(name);
		if (existing && JSON.stringify(existing.config) === JSON.stringify(config)) return;
		if (existing) this.unregister(name);
		// Baseline the current listing so pre-existing files don't fire on arm — only changes after.
		const prev = this.scan(config.path);
		const handle = this.timers.set(() => this.poll(name), this.intervalMs);
		this.tracked.set(name, { config, prev, handle });
	}

	unregister(name: string): void {
		const t = this.tracked.get(name);
		if (!t) return;
		this.timers.clear(t.handle);
		this.tracked.delete(name);
	}

	dispose(): void {
		for (const t of this.tracked.values()) this.timers.clear(t.handle);
		this.tracked.clear();
	}

	private poll(name: string): void {
		const t = this.tracked.get(name);
		if (!t) return;
		const curr = this.scan(t.config.path);
		const events = diffListings(t.prev, curr);
		t.prev = curr;
		if (t.config.events.some((e) => events.has(e))) this.actions.fire(name);
	}
}
