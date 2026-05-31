import { type ChildProcess, spawn } from "node:child_process";
import { createWriteStream, type WriteStream } from "node:fs";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import type { LoadResult } from "../services/loader.js";
import { buildPiArgs, type ServiceConfig } from "../services/schema.js";
import type { StateStore } from "../state/store.js";
import { attachJsonlReader } from "../util/jsonl.js";
import { expandTilde, logsDir } from "../util/paths.js";

/** Grace period after `pi` settles before an already-exited child is treated as a startup failure. Mirrors pi's RpcClient.start(). */
const SPAWN_SETTLE_MS = 100;
/** Grace period between SIGTERM and SIGKILL when reaping a child. Mirrors pi's RpcClient.stop(). */
const TERMINATE_GRACE_MS = 1000;

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
 * Runtime handle for a spawned subprocess. Kept in a sidecar map, separate from
 * the serializable `ServiceRecord`, because a live `ChildProcess` (and its streams)
 * cannot cross the control-plane socket as JSON.
 */
interface RunningProcess {
	child: ChildProcess;
	log: WriteStream;
	stderr: string;
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
	private readonly running: Map<string, RunningProcess>;

	constructor(opts: SupervisorOptions) {
		this.state = opts.state;
		this.services = new Map();
		this.running = new Map();
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
		if (this.running.has(name)) {
			throw new Error(`service already running: ${name}`);
		}

		record.state = "starting";
		record.lastFailure = undefined;

		const args = buildPiArgs(record.config);
		const cwd = record.config.cwd ? expandTilde(record.config.cwd) : undefined;

		await mkdir(logsDir(), { recursive: true });
		const log = createWriteStream(join(logsDir(), `${name}.jsonl`), { flags: "a" });

		const child = spawn(record.config.command, args, {
			cwd,
			env: { ...process.env, ...record.config.env },
			stdio: ["pipe", "pipe", "pipe"],
		});

		const running: RunningProcess = { child, log, stderr: "" };
		this.running.set(name, running);
		record.pid = child.pid;

		// Capture stderr for diagnostics and forward it, prefixed (the daemon multiplexes services).
		child.stderr?.on("data", (chunk: Buffer) => {
			const text = chunk.toString();
			running.stderr += text;
			process.stderr.write(`[${name}] ${text}`);
		});

		// Consume the stdout event stream. Every event is appended raw to the per-service
		// log; `onServiceEvent` is the (currently no-op) seam to the governor/crash/approval modules.
		if (child.stdout) {
			attachJsonlReader(
				child.stdout,
				(event) => {
					log.write(`${JSON.stringify(event)}\n`);
					this.onServiceEvent(name, event);
				},
				(err, raw) => {
					// Malformed line: warn, skip, continue (spec: failure modes).
					process.stderr.write(`[${name}] skipped malformed event line: ${err.message}\n`);
					log.write(`${JSON.stringify({ type: "pid_parse_error", error: err.message, raw })}\n`);
				},
			);
		}

		// Guarded by sidecar identity so a stale handler from a prior spawn can't fire (mirrors pi's RpcClient).
		child.once("error", (err) => {
			if (this.running.get(name)?.child !== child) return;
			this.finalizeExit(name, child, null, null, err);
		});
		child.once("exit", (code, signal) => {
			if (this.running.get(name)?.child !== child) return;
			this.finalizeExit(name, child, code, signal, null);
		});

		// pi exposes no "ready" signal, so — like pi's own RpcClient.start() — let the process
		// settle, then treat a child that has already gone (exit or spawn error) as a startup failure.
		// Sidecar presence is the readiness check: `finalizeExit` removes the entry on early death,
		// which also catches ENOENT (an `error` event with a null exit code).
		await sleep(SPAWN_SETTLE_MS);

		if (!this.running.has(name)) {
			// Re-fetch: `finalizeExit` set `lastFailure` from an async handler the type-checker can't track.
			const failed = this.services.get(name);
			const reason = failed?.lastFailure?.signature || running.stderr.trim() || "process exited during startup";
			throw new Error(`failed to start ${name}: ${reason}`);
		}

		record.state = "running";
		record.startedAt = new Date().toISOString();
		return { name, state: record.state };
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
		// Reap every running child so the daemon doesn't orphan pi processes.
		// Graceful abort-first teardown lands with stop(); this is plain SIGTERM→SIGKILL.
		await Promise.all([...this.running.values()].map((rp) => this.terminate(rp.child)));
	}

	/**
	 * Single dispatch seam for parsed subprocess events. Events are already appended
	 * to the raw log by the caller; routing to the cost governor, crash detector, and
	 * approval router lands when those modules are built.
	 */
	private onServiceEvent(_name: string, _event: unknown): void {
		// TODO(governor/crash/approval): route events to the consumer modules.
	}

	/** Transition a service out of the running set on child exit or spawn error. */
	private finalizeExit(
		name: string,
		child: ChildProcess,
		code: number | null,
		signal: NodeJS.Signals | null,
		error: Error | null,
	): void {
		const running = this.running.get(name);
		if (!running || running.child !== child) return;
		this.running.delete(name);
		running.log.end();

		const record = this.services.get(name);
		if (!record) return;
		record.pid = undefined;

		const at = new Date().toISOString();
		if (error) {
			record.state = "failed";
			record.lastFailure = { at, signature: "proc:spawn_error" };
		} else if (code === 0 || signal !== null) {
			// Clean exit, or terminated by a signal (assumed our own SIGTERM until stop() refines this).
			record.state = "stopped";
		} else {
			record.state = "failed";
			record.lastFailure = { at, signature: `proc:exit_${code}` };
		}
	}

	/** SIGTERM a child, escalating to SIGKILL after a grace period. Mirrors pi's RpcClient.stop(). */
	private terminate(child: ChildProcess): Promise<void> {
		return new Promise((resolve) => {
			if (child.exitCode !== null || child.signalCode !== null) {
				resolve();
				return;
			}
			const kill = setTimeout(() => child.kill("SIGKILL"), TERMINATE_GRACE_MS);
			child.once("exit", () => {
				clearTimeout(kill);
				resolve();
			});
			child.kill("SIGTERM");
		});
	}

	private requireService(name: string): ServiceRecord {
		const record = this.services.get(name);
		if (!record) throw new Error(`unknown service: ${name}`);
		return record;
	}
}
