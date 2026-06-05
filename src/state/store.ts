import { readFile, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { stateDir } from "../util/paths.js";

interface PersistedState {
	version: 1;
	enabled: string[];
	/** Services held in crash-loop quarantine (ADR 0003). Mirrors `enabled`: a sorted name-list,
	 *  the durable source of truth for the terminal quarantine bit, re-held on boot. */
	quarantined: string[];
}

const DEFAULT_STATE: PersistedState = { version: 1, enabled: [], quarantined: [] };

/** Process-global counter for temp filenames, so two stores in one process never collide (S1). */
let tmpCounter = 0;

export class StateStore {
	/** Serializes writes from this store so concurrent state-changing ops can't interleave their
	 *  write→rename and clobber state.json (mirrors the per-service queue in governor/crash.ts). */
	private queue: Promise<void> = Promise.resolve();

	private constructor(
		private readonly path: string,
		private state: PersistedState,
	) {}

	static async open(): Promise<StateStore> {
		const path = join(stateDir(), "state.json");
		let state: PersistedState;
		try {
			const text = await readFile(path, "utf8");
			// Merge over defaults so a state.json written before a field existed (e.g. pre-quarantine)
			// loads with that field defaulted rather than undefined.
			state = { ...DEFAULT_STATE, ...(JSON.parse(text) as Partial<PersistedState>) };
		} catch (err) {
			const code = (err as NodeJS.ErrnoException).code;
			if (code === "ENOENT") {
				state = { ...DEFAULT_STATE };
			} else {
				throw err;
			}
		}
		return new StateStore(path, state);
	}

	async getEnabled(): Promise<string[]> {
		return [...this.state.enabled];
	}

	async setEnabled(name: string, enabled: boolean): Promise<void> {
		const set = new Set(this.state.enabled);
		if (enabled) set.add(name);
		else set.delete(name);
		this.state = { ...this.state, enabled: [...set].sort() };
		await this.persist();
	}

	async getQuarantined(): Promise<string[]> {
		return [...this.state.quarantined];
	}

	async setQuarantined(name: string, quarantined: boolean): Promise<void> {
		const set = new Set(this.state.quarantined);
		if (quarantined) set.add(name);
		else set.delete(name);
		this.state = { ...this.state, quarantined: [...set].sort() };
		await this.persist();
	}

	private persist(): Promise<void> {
		// Snapshot now: state objects are replaced wholesale by the setters, so this captures the
		// exact state to write even though the write runs later in the queue.
		const snapshot = this.state;
		const run = this.queue.then(() => this.write(snapshot));
		// Keep the chain alive even if this write rejects, so one failure can't poison later persists;
		// the caller still observes the rejection through `run`.
		this.queue = run.catch(() => {});
		return run;
	}

	private async write(state: PersistedState): Promise<void> {
		// Unique temp name per write (pid + monotonic counter) so concurrent writers — even two stores
		// sharing one PID_HOME — never share a temp file and lose a rename to ENOENT (S1).
		const tmp = `${this.path}.${process.pid}.${++tmpCounter}.tmp`;
		await writeFile(tmp, JSON.stringify(state, null, 2), "utf8");
		await rename(tmp, this.path);
	}
}
