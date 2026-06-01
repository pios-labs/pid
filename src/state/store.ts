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

export class StateStore {
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

	private async persist(): Promise<void> {
		const tmp = `${this.path}.tmp`;
		await writeFile(tmp, JSON.stringify(this.state, null, 2), "utf8");
		await rename(tmp, this.path);
	}
}
