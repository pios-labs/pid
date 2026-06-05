import { type ChildProcess, spawn } from "node:child_process";
import { createWriteStream, type WriteStream } from "node:fs";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { type ApprovalActions, ApprovalRouter, type PendingApproval } from "../approvals/router.js";
import { BudgetStore, type OverrideState } from "../budget/store.js";
import { type BudgetActions, CostGovernor } from "../governor/cost.js";
import { type CrashActions, CrashDetector } from "../governor/crash.js";
import type { LoadResult } from "../services/loader.js";
import { buildPiArgs, type ServiceConfig } from "../services/schema.js";
import type { StateStore } from "../state/store.js";
import { attachJsonlReader, serializeJsonLine } from "../util/jsonl.js";
import { formatPidEvent, formatPiEvent } from "../util/log.js";
import { expandTilde, logsDir } from "../util/paths.js";

/** Per-dimension manual budget override (number = new ceiling, null = unlimited, absent = unchanged). */
export type BudgetOverrideSpec = OverrideState;

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

/**
 * The status-command view of a service: the runtime record plus the live count of in-flight
 * approval dialogs (ADR 0006 fork-3). `pendingApprovals` is **derived on read** from the approval
 * router — never a stored field on `ServiceRecord` (the inbox is the source of truth; a stored tally
 * would only drift). Returned by `status()`/`list()` so both the human render and `--json` carry it
 * from the one payload, mirroring pi's "same data, many renderings" (`--mode text|json`).
 */
export interface ServiceStatus extends ServiceRecord {
	pendingApprovals: number;
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
export class Supervisor implements BudgetActions, CrashActions, ApprovalActions {
	private readonly state: StateStore;
	private readonly services: Map<string, ServiceRecord>;
	private readonly running: Map<string, RunningProcess>;
	/** Built in init() only when a service declares a budget; undefined otherwise. */
	private governor?: CostGovernor;
	/** Always present: crash detection is core supervision, on for every service (ADR 0003). */
	private readonly crash: CrashDetector;
	/** Always present: routes pi dialogs to the CLI inbox and auto-answers per policy (ADR 0004). */
	private readonly approvals: ApprovalRouter;

	constructor(opts: SupervisorOptions) {
		this.state = opts.state;
		this.services = new Map();
		this.running = new Map();
		this.crash = new CrashDetector({ actions: this });
		this.approvals = new ApprovalRouter({ actions: this });
		for (const config of opts.services.services) {
			this.services.set(config.name, { name: config.name, config, state: "stopped" });
			this.crash.register(config.name, config.quarantine);
			this.approvals.register(config.name, {
				gate: config.gate,
				autoApprove: config.auto_approve,
				onUnmatched: config.on_unmatched,
			});
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

		// Re-hold services quarantined before this daemon started (ADR 0003): the persisted
		// quarantined[] set is the durable source of truth. The in-session failure window is
		// intentionally not persisted, so we restore only the terminal bit — startEnabled then
		// skips these, and start()'s guard refuses a manual start until `pid unquarantine`.
		for (const name of await this.state.getQuarantined()) {
			const record = this.services.get(name);
			if (record) record.state = "quarantined";
		}
	}

	list(): ServiceStatus[] {
		const pending = this.pendingCounts();
		return [...this.services.values()].map((record) => ({ ...record, pendingApprovals: pending.get(record.name) ?? 0 }));
	}

	status(name?: string): ServiceStatus | ServiceStatus[] {
		if (!name) return this.list();
		const record = this.services.get(name);
		if (!record) throw new Error(`unknown service: ${name}`);
		return { ...record, pendingApprovals: this.pendingCounts().get(name) ?? 0 };
	}

	/** Per-service count of in-flight approvals, derived live from the router (never stored; ADR 0006). */
	private pendingCounts(): Map<string, number> {
		const counts = new Map<string, number>();
		for (const approval of this.approvals.list()) {
			counts.set(approval.service, (counts.get(approval.service) ?? 0) + 1);
		}
		return counts;
	}

	async start(name: string): Promise<{ name: string; state: ServiceState }> {
		const record = this.requireService(name);
		if (record.state === "paused") {
			// A budget-paused service must not be silently force-started (it would quietly run past
			// its cap). Make the user choose explicitly via `pid resume`. See ADR 0002.
			throw new Error(`service is budget-paused: ${name} — use \`pid resume ${name}\` to resume`);
		}
		if (record.state === "quarantined") {
			// A crash-looping service is held until a human confirms the fault is fixed; never
			// auto-/force-start it back into the loop. See ADR 0003.
			throw new Error(`service is quarantined (crash loop): ${name} — use \`pid unquarantine ${name}\` to clear`);
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

		// Swallow stdin errors so a broken pipe (pi exits mid-write) can't crash the daemon as an
		// unhandled 'error' event. Mirrors pi's own RpcClient, which attaches this guard at spawn.
		// `send()` surfaces the failure to its caller via the write callback; this only logs and is
		// sidecar-guarded so a stale handler from a prior spawn stays quiet.
		child.stdin?.on("error", (err) => {
			if (this.running.get(name)?.child !== child) return;
			process.stderr.write(`[${name}] stdin error: ${err.message}\n`);
		});

		// Consume the stdout event stream. Every event is appended raw to the per-service
		// log; `onServiceEvent` is the (currently no-op) seam to the governor/crash/approval modules.
		if (child.stdout) {
			running.detachReader = attachJsonlReader(
				child.stdout,
				(event) => {
					// Every line is enveloped (ADR 0005): pi's event is preserved verbatim under `data`.
					// onServiceEvent still receives the raw parsed event — the envelope is a log-format
					// concern only, not part of the in-process event the governor/crash detector react to.
					log.write(formatPiEvent(name, event, new Date().toISOString()));
					this.onServiceEvent(name, event);
				},
				(err, raw) => {
					// Malformed line: warn, skip, continue (spec: failure modes).
					process.stderr.write(`[${name}] skipped malformed event line: ${err.message}\n`);
					log.write(formatPidEvent(name, "pid_parse_error", { error: err.message, raw }, new Date().toISOString()));
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

	/**
	 * Manual budget override + resume (the `pid resume --daily/--weekly/--unlimited/--reset` path,
	 * ADR 0002). Delegates to the governor, which sets the window-scoped override (or resets the
	 * window), resumes via resume() above, and re-pauses if a surviving guardrail is still breached.
	 */
	async resumeWithOverride(
		name: string,
		spec: BudgetOverrideSpec,
		reset = false,
	): Promise<{ name: string; state: ServiceState }> {
		const record = this.requireService(name);
		if (!this.governor) throw new Error(`service has no budget: ${name}`);
		await this.governor.override(name, spec, reset);
		return { name, state: record.state };
	}

	/**
	 * Crash-detector action: quarantine a service after a crash loop (ADR 0003). Like pause() it
	 * gracefully stops the child (so the closing events still flush), but the state is *terminal* —
	 * no auto-resume — and it is persisted to the quarantined[] set so a daemon restart keeps
	 * holding it. The triggering failure signature is surfaced on status as the "why".
	 */
	async quarantine(name: string): Promise<void> {
		await this.stop(name);
		const record = this.requireService(name);
		record.state = "quarantined";
		const failure = this.crash.status(name)?.lastFailure;
		if (failure) record.lastFailure = failure;
		await this.state.setQuarantined(name, true);
	}

	/**
	 * Clear a quarantine (the `pid unquarantine` path): drop the persisted bit, reset the detector's
	 * failure history, and return the service to `stopped` so it can be started again. Idempotent on
	 * a service that isn't quarantined.
	 */
	async unquarantine(name: string): Promise<{ name: string; state: ServiceState }> {
		const record = this.requireService(name);
		if (record.state === "quarantined") record.state = "stopped";
		this.crash.clear(name);
		await this.state.setQuarantined(name, false);
		return { name, state: record.state };
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
			// A quarantined service stays held across restarts (ADR 0003) — never auto-start it
			// back into the crash loop. init() already restored its state from the persisted set.
			if (this.requireService(name).state === "quarantined") continue;
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
		// Cancel any pending budget resume + approval-timeout timers so none outlives the daemon.
		this.governor?.dispose();
		this.approvals.dispose();
		// Reap every running child so the daemon doesn't orphan pi processes.
		// Graceful teardown lives in stop(); this is plain SIGTERM→SIGKILL.
		await Promise.all([...this.running.values()].map((rp) => this.terminate(rp.child)));
	}

	/**
	 * Write one JSONL message to a running service's stdin — the host→pi direction, counterpart to
	 * the stdout event reader. Frames with `serializeJsonLine` (LF-only), exactly the framing pi's
	 * `RpcClient` uses to talk to a pi subprocess. The approval router is the first consumer: it
	 * replies to an `extension_ui_request` with an `extension_ui_response`.
	 *
	 * Resolves once the line is accepted by the pipe; rejects if the service isn't running or the
	 * write fails (e.g. pi closed stdin / exited mid-reply). The guards mirror pi's own `send()`:
	 * a dead or exiting child, or an unwritable stdin, is a surfaced error, not a silent no-op — the
	 * router needs to know a reply didn't land. (`stop()` ends stdin to trigger pi's shutdown, so a
	 * send racing a stop legitimately rejects here.)
	 */
	async send(name: string, message: unknown): Promise<void> {
		this.requireService(name);
		const running = this.running.get(name);
		if (!running) throw new Error(`cannot send to ${name}: service not running`);

		const { stdin } = running.child;
		if (!stdin || stdin.destroyed || !stdin.writable || running.child.exitCode !== null) {
			throw new Error(`cannot send to ${name}: stdin is not writable`);
		}

		await new Promise<void>((resolve, reject) => {
			stdin.write(serializeJsonLine(message), (err) => {
				if (err) reject(err);
				else resolve();
			});
		});
	}

	/**
	 * Single dispatch seam for parsed subprocess events. Events are already appended to the raw
	 * log by the caller. The cost governor (budgeted services only) and the crash detector (all
	 * services) consume here; the approval router will hang off too. Both handleEvent methods are
	 * self-serializing — fire-and-forget.
	 */
	private onServiceEvent(name: string, event: unknown): void {
		void this.governor?.handleEvent(name, event);
		void this.crash.handleEvent(name, event);
		this.approvals.handleEvent(name, event);
	}

	/**
	 * Append a documented `pid_*` synthetic intervention event to the service's chronicle, enveloped
	 * like every other line (ADR 0005). The single writer behind every consumer's intervention log —
	 * the approval router, the crash detector, and the cost governor — so all pid interventions land
	 * in the one ordered, replayable timeline the observability mandate requires.
	 *
	 * No-op if the service isn't running: the chronicle is the live `RunningProcess.log` stream, so
	 * an event for a stopped service has nowhere to go. Consumers therefore log a pause/quarantine
	 * *before* the stop that fulfils it, and a resume *after* the start — see each call site.
	 */
	private logPidEvent(name: string, type: string, data: Record<string, unknown>): void {
		const running = this.running.get(name);
		if (!running) return;
		running.log.write(formatPidEvent(name, type, data, new Date().toISOString()));
	}

	/** ApprovalActions: a `pid_approval` event (ADR 0004 §11). */
	logApproval(name: string, data: Record<string, unknown>): void {
		this.logPidEvent(name, "pid_approval", data);
	}

	/** CrashActions: a `pid_quarantine` event (ADR 0003 / 0005). Emitted before the quarantine stop. */
	logQuarantine(name: string, data: Record<string, unknown>): void {
		this.logPidEvent(name, "pid_quarantine", data);
	}

	/** BudgetActions: a `pid_budget_pause` event (ADR 0002 / 0005). Emitted before the pause stop. */
	logBudgetPause(name: string, data: Record<string, unknown>): void {
		this.logPidEvent(name, "pid_budget_pause", data);
	}

	/** BudgetActions: a `pid_budget_resume` event (ADR 0002 / 0005). Emitted after the resume start. */
	logBudgetResume(name: string, data: Record<string, unknown>): void {
		this.logPidEvent(name, "pid_budget_resume", data);
	}

	/** Pending approvals across all services (the `approvals` command; CLI dispatch in increment D). */
	listApprovals(): PendingApproval[] {
		return this.approvals.list();
	}

	/** Approve a pending dialog (`pid approve`); replies to pi over stdin. Rejects if the id isn't pending. */
	approveRequest(id: string, value?: string): Promise<PendingApproval> {
		return this.approvals.approve(id, value);
	}

	/** Deny a pending dialog (`pid deny`). Rejects if the id isn't pending. */
	denyRequest(id: string, reason?: string): Promise<PendingApproval> {
		return this.approvals.deny(id, reason);
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
