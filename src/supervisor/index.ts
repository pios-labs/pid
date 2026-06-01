import { type ChildProcess, spawn } from "node:child_process";
import { createWriteStream, type WriteStream } from "node:fs";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { BudgetStore } from "../budget/store.js";
import { type BudgetActions, CostGovernor } from "../governor/cost.js";
import type { LoadResult } from "../services/loader.js";
import { buildPiArgs, type ServiceConfig } from "../services/schema.js";
import type { StateStore } from "../state/store.js";
import { attachJsonlReader } from "../util/jsonl.js";
import { expandTilde, logsDir } from "../util/paths.js";

/** Grace period after `pi` settles before an already-exited child is treated as a startup failure. Mirrors pi's RpcClient.start(). */
const SPAWN_SETTLE_MS = 100;
/** How long to wait for pi to exit after closing its stdin before escalating to SIGTERM. See `Supervisor.stop()` for why stdin-close is the primary path. */
const STOP_GRACE_MS = 5000;
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
	/** Detaches the stdout JSONL reader; called before `log.end()` so a late end-flush can't write after close. */
	detachReader: () => void;
}

/**
 * Owns the lifecycle of all supervised services. Spawns pi --mode rpc subprocesses,
 * consumes their event streams, applies restart policy, and exposes status via the
 * control plane.
 *
 * v0 scaffold: methods stub out, structure is in place. Real implementations land in
 * follow-up commits.
 */
export class Supervisor implements BudgetActions {
	private readonly state: StateStore;
	private readonly services: Map<string, ServiceRecord>;
	private readonly running: Map<string, RunningProcess>;
	/** Built in init() only when a service declares a budget; undefined otherwise. */
	private governor?: CostGovernor;

	constructor(opts: SupervisorOptions) {
		this.state = opts.state;
		this.services = new Map();
		this.running = new Map();
		for (const config of opts.services.services) {
			this.services.set(config.name, { name: config.name, config, state: "stopped" });
		}
	}

	/**
	 * Open per-service budget stores and wire the cost governor. Call once after construction,
	 * before startEnabled(). No-op when no service declares a budget.
	 */
	async init(): Promise<void> {
		let governor: CostGovernor | undefined;
		for (const record of this.services.values()) {
			const budget = record.config.budget;
			if (!budget) continue;
			governor ??= new CostGovernor({ actions: this });
			const store = await BudgetStore.open(record.name);
			governor.register(record.name, budget, store);
		}
		this.governor = governor;
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
		if (record.state === "paused") {
			// A budget-paused service must not be silently force-started (it would quietly run past
			// its cap). Make the user choose explicitly via `pid resume`. See ADR 0002.
			throw new Error(`service is budget-paused: ${name} — use \`pid resume ${name}\` to resume`);
		}
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

		const running: RunningProcess = { child, log, stderr: "", detachReader: () => {} };
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
			running.detachReader = attachJsonlReader(
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

	/**
	 * Stop a running service by closing pi's stdin, escalating to signals only if pi ignores it.
	 *
	 * WHY stdin-close instead of SIGTERM (this is a deliberate, source-verified choice — do not
	 * "simplify" it to a plain kill without re-reading the pi source referenced below):
	 *
	 * pi's rpc mode has three clean-shutdown triggers, and they are NOT equivalent. All three run
	 * `runtimeHost.dispose()` (releasing extension resources — sockets, file handles), but they
	 * differ in one respect that is decisive for pid:
	 *
	 *   - stdin EOF  -> `shutdown(0)`   -> dispose, FLUSH remaining stdout, exit 0
	 *   - SIGTERM    -> `shutdown(143)` -> dispose, SKIP the flush,        exit 143
	 *   - SIGHUP     -> `shutdown(129)` -> dispose, flush,                 exit 129
	 *
	 * The flush gate is literally `if (signal !== "SIGTERM") await flushRawStdout();` in pi's
	 * `shutdown()`. So a SIGTERM stop can truncate pi's final buffered events before they reach us.
	 * For pid those final events are the whole point — they carry the closing cost/usage totals the
	 * cost governor and the on-disk log exist to capture. Losing the tail on every stop would
	 * quietly corrupt our accounting. Closing stdin takes the no-signal path, so we get the flush
	 * AND a clean exit 0 (an unambiguous "stopped on purpose" marker the crash detector can trust,
	 * vs. 143 which looks like a signal death). We keep our stdout reader attached through shutdown
	 * precisely so that flushed tail lands in the log.
	 *
	 * The cost: pi's OWN reference client (`RpcClient.stop()`) uses the SIGTERM path, so we are
	 * deliberately diverging from pi's bundled supervisor. We judge that acceptable because that
	 * client is ephemeral and discards late output, whereas pid's raison d'être is capturing it.
	 * We still fall back to exactly the RpcClient teardown (SIGTERM -> SIGKILL) if pi ignores EOF.
	 *
	 * Note: `abort` ({"type":"abort"}) is NOT a shutdown — it only cancels the current agent turn
	 * and pi keeps running. Our older docs wrongly described it as the graceful-cleanup mechanism.
	 *
	 * WATCH-POINT for future pi releases: if pi ever makes SIGTERM also flush (i.e. drops the
	 * `signal !== "SIGTERM"` guard in `shutdown()`), the SIGTERM-only approach becomes equivalent
	 * and strictly simpler — revisit this method then. Conversely, if pi ever stops treating stdin
	 * EOF as a shutdown request (`onInputEnd`), this degrades to the 5s fallback on every stop;
	 * watch for that regression.
	 *
	 * Verified against pi @ 3911d6f5 (2026-05-30), packages/coding-agent/src/modes/rpc:
	 *   - rpc-mode.ts ~680-697  `shutdown()` + the `signal !== "SIGTERM"` flush gate
	 *   - rpc-mode.ts ~362-373  SIGTERM/SIGHUP -> shutdown(143/129)
	 *   - rpc-mode.ts ~756-758  `onInputEnd` -> `void shutdown()` (the stdin-EOF path, exit 0)
	 *   - rpc-mode.ts ~423      `case "abort"` -> `session.abort()` (cancels turn, no exit)
	 *   - rpc-client.ts ~143-165 `RpcClient.stop()` (the SIGTERM->SIGKILL path we keep as fallback)
	 */
	async stop(name: string): Promise<{ name: string; state: ServiceState }> {
		const record = this.requireService(name);
		const running = this.running.get(name);
		if (!running) {
			// Not running. A manual stop of a budget-paused service means "I'm taking control —
			// don't auto-resume": transition it to stopped and cancel the governor's pending resume.
			if (record.state === "paused") {
				record.state = "stopped";
				this.governor?.cancelResume(name);
			}
			// Otherwise idempotent, like `systemctl stop` on a dead unit.
			return { name, state: record.state };
		}

		record.state = "stopping";

		// Graceful path: close pi's stdin -> pi takes the no-signal `shutdown(0)` branch (see above).
		const { child } = running;
		if (child.stdin && !child.stdin.destroyed) {
			child.stdin.end();
		}

		// Wait for the graceful exit; `finalizeExit` handles state/cleanup on the exit event.
		const exited = await this.waitForExit(child, STOP_GRACE_MS);
		if (!exited) {
			// pi ignored the stdin close (wedged, or a build without the EOF->shutdown path):
			// fall back to pi's own RpcClient teardown — SIGTERM, then SIGKILL after a grace period.
			await this.terminate(child);
		}

		return { name, state: record.state };
	}

	async restart(name: string): Promise<{ name: string; state: ServiceState }> {
		await this.stop(name);
		return this.start(name);
	}

	/**
	 * Cost-governor action: pause a service by stopping it and marking it `paused` (vs the
	 * `stopped` that stop() leaves). The governor schedules the resume; resume() reverses it.
	 */
	async pause(name: string): Promise<void> {
		await this.stop(name);
		this.requireService(name).state = "paused";
	}

	/**
	 * Cost-governor action: resume a paused service. Idempotent if already running. Clears the
	 * `paused` state so start()'s guard allows the spawn.
	 */
	async resume(name: string): Promise<void> {
		if (this.running.has(name)) return;
		const record = this.requireService(name);
		if (record.state === "paused") record.state = "stopped";
		await this.start(name);
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
				// A budgeted service that was over-cap before a restart stays held until its window
				// resets; recover() re-arms the resume timer from the persisted budget state.
				if (this.governor) {
					const { stillPaused } = await this.governor.recover(name);
					if (stillPaused) {
						this.requireService(name).state = "paused";
						continue;
					}
				}
				await this.start(name);
			} catch (err) {
				process.stderr.write(`pid: failed to start ${name}: ${err instanceof Error ? err.message : String(err)}\n`);
			}
		}
	}

	async shutdown(): Promise<void> {
		// Cancel any pending budget resume timers so none outlives the daemon.
		this.governor?.dispose();
		// Reap every running child so the daemon doesn't orphan pi processes.
		// Graceful teardown lives in stop(); this is plain SIGTERM→SIGKILL.
		await Promise.all([...this.running.values()].map((rp) => this.terminate(rp.child)));
	}

	/**
	 * Single dispatch seam for parsed subprocess events. Events are already appended to the raw
	 * log by the caller. The cost governor is the first consumer; the crash detector and approval
	 * router will hang off here too. handleEvent is self-serializing — fire-and-forget.
	 */
	private onServiceEvent(name: string, event: unknown): void {
		void this.governor?.handleEvent(name, event);
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
		// Detach the reader before ending the log: the stdout `end` event can flush a final
		// buffered line concurrently with exit, and writing to an ended WriteStream throws.
		running.detachReader();
		running.log.end();

		const record = this.services.get(name);
		if (!record) return;
		record.pid = undefined;

		const at = new Date().toISOString();
		if (error) {
			record.state = "failed";
			record.lastFailure = { at, signature: "proc:spawn_error" };
		} else if (code === 0 || signal !== null) {
			// Clean exit (graceful stop yields code 0), or terminated by a signal — our own
			// SIGTERM/SIGKILL fallback in stop()/shutdown(). The crash detector will later
			// distinguish a self-inflicted fatal signal from a deliberate teardown.
			record.state = "stopped";
		} else {
			record.state = "failed";
			record.lastFailure = { at, signature: `proc:exit_${code}` };
		}
	}

	/** Resolve `true` if the child exits within `ms`, else `false`. Already-exited children resolve `true`. */
	private waitForExit(child: ChildProcess, ms: number): Promise<boolean> {
		return new Promise((resolve) => {
			if (child.exitCode !== null || child.signalCode !== null) {
				resolve(true);
				return;
			}
			const timer = setTimeout(() => {
				child.off("exit", onExit);
				resolve(false);
			}, ms);
			const onExit = () => {
				clearTimeout(timer);
				resolve(true);
			};
			child.once("exit", onExit);
		});
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
