import type { LoadResult } from "../services/loader.js";
import type { ServiceConfig } from "../services/schema.js";
import type { StateStore } from "../state/store.js";

export type ServiceState = "stopped" | "starting" | "running" | "stopping" | "paused" | "quarantined" | "failed";

export interface ServiceRecord {
	name: string;
	config: ServiceConfig;
	state: ServiceState;
	pid?: number;
	startedAt?: string;
	lastFailure?: { at: string; signature: string };
}

export interface SupervisorOptions {
	state: StateStore;
	services: LoadResult;
}

/**
 * Owns the lifecycle of all supervised services. Spawns pi --mode rpc subprocesses,
 * consumes their event streams, applies restart policy, and exposes status via the
 * control plane.
 *
 * v0 scaffold: methods stub out, structure is in place. Real implementations land in
 * follow-up commits.
 */
export class Supervisor {
	private readonly state: StateStore;
	private readonly services: Map<string, ServiceRecord>;

	constructor(opts: SupervisorOptions) {
		this.state = opts.state;
		this.services = new Map();
		for (const config of opts.services.services) {
			this.services.set(config.name, { name: config.name, config, state: "stopped" });
		}
	}

	list(): ServiceRecord[] {
		return [...this.services.values()];
	}

	status(name?: string): ServiceRecord | ServiceRecord[] {
		if (!name) return this.list();
		const record = this.services.get(name);
		if (!record) throw new Error(`unknown service: ${name}`);
		return record;
	}

	async start(name: string): Promise<{ name: string; state: ServiceState }> {
		const record = this.requireService(name);
		// TODO: spawn pi subprocess, attach event consumer, transition state
		throw new Error(`start: not implemented (would start ${record.name})`);
	}

	async stop(name: string): Promise<{ name: string; state: ServiceState }> {
		const record = this.requireService(name);
		// TODO: send abort over stdin, SIGTERM after grace, wait for exit
		throw new Error(`stop: not implemented (would stop ${record.name})`);
	}

	async restart(name: string): Promise<{ name: string; state: ServiceState }> {
		await this.stop(name);
		return this.start(name);
	}

	async enable(name: string): Promise<void> {
		this.requireService(name);
		await this.state.setEnabled(name, true);
	}

	async disable(name: string): Promise<void> {
		this.requireService(name);
		await this.state.setEnabled(name, false);
	}

	async startEnabled(): Promise<void> {
		const enabled = await this.state.getEnabled();
		for (const name of enabled) {
			if (!this.services.has(name)) continue;
			try {
				await this.start(name);
			} catch (err) {
				process.stderr.write(`pid: failed to start ${name}: ${err instanceof Error ? err.message : String(err)}\n`);
			}
		}
	}

	async shutdown(): Promise<void> {
		// TODO: stop all running services in parallel, persist state
	}

	private requireService(name: string): ServiceRecord {
		const record = this.services.get(name);
		if (!record) throw new Error(`unknown service: ${name}`);
		return record;
	}
}
