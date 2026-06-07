#!/usr/bin/env node
import { join } from "node:path";
import { Command } from "commander";
import type { PendingApproval } from "./approvals/router.js";
import { promptValue, resolveApprovalId, ValueEntryCancelled } from "./cli-prompt.js";
import {
	formatActionReceipt,
	formatApprovalsTable,
	formatApproveReceipt,
	formatBudget,
	formatDenyReceipt,
	formatReloadSummary,
	formatStatus,
} from "./cli-render.js";
import { runDaemon } from "./daemon.js";
import type { BudgetView } from "./governor/cost.js";
import { type LogFilter, listLiveServices, matchesFilter, parseSince, readChronicle } from "./log/reader.js";
import { formatLogLine, logDay } from "./log/render.js";
import { FileTailer } from "./log/tail.js";
import { connect, type Request, sendCommand } from "./protocol/socket.js";
import { parseResumeFlags, type ResumeFlags } from "./services/resume-args.js";
import type { ReloadSummary, ServiceStatus } from "./supervisor/index.js";
import type { LogEnvelope } from "./util/log.js";
import { logsDir } from "./util/paths.js";

interface LogsFlags {
	follow?: boolean;
	raw?: boolean;
	since?: string;
	type?: string;
	source?: string;
}

/** Narrow the action-command payload (`{ name, state }`) for the receipt's `→ <state>`. */
function landedState(data: unknown): string | undefined {
	return (data as { state?: string } | undefined)?.state;
}

/** The message of an unknown thrown value, for a plain stderr line. */
function errMsg(err: unknown): string {
	return err instanceof Error ? err.message : String(err);
}

/** Fetch the pending-approval inbox (one round-trip), for client-side id resolution and value entry. */
async function fetchApprovals(): Promise<PendingApproval[]> {
	const socket = await connect();
	try {
		const res = await sendCommand(socket, { cmd: "approvals" });
		if (!res.ok) throw new Error(res.error);
		return res.data as PendingApproval[];
	} finally {
		socket.end();
	}
}

const VERSION = "0.0.1";

const program = new Command();

program.name("pid").description("Supervisor for pi agents").version(VERSION, "-v, --version");

program
	.command("daemon")
	.description("Run the pid daemon in the foreground")
	.action(async () => {
		await runDaemon();
	});

program
	.command("list")
	.alias("ls")
	.description("List all services")
	.option("--json", "output the raw JSON payload instead of the table")
	.action(async (opts: { json?: boolean }) => {
		await renderDaemon({ cmd: "list" }, opts.json, (data) => formatStatus(data as ServiceStatus[], Date.now()));
	});

program
	.command("status [name]")
	.description("Show status for one or all services")
	.option("--json", "output the raw JSON payload instead of the rendered view")
	.action(async (name: string | undefined, opts: { json?: boolean }) => {
		await renderDaemon({ cmd: "status", name }, opts.json, (data) =>
			formatStatus(data as ServiceStatus | ServiceStatus[], Date.now()),
		);
	});

program
	.command("start <name>")
	.description("Start a stopped service")
	.option("--json", "output the raw JSON payload instead of a receipt")
	.action(async (name: string, opts: { json?: boolean }) => {
		await renderDaemon({ cmd: "start", name }, opts.json, (data) =>
			formatActionReceipt("started", name, landedState(data)),
		);
	});

program
	.command("stop <name>")
	.description("Stop a running service")
	.option("--json", "output the raw JSON payload instead of a receipt")
	.action(async (name: string, opts: { json?: boolean }) => {
		await renderDaemon({ cmd: "stop", name }, opts.json, (data) =>
			formatActionReceipt("stopped", name, landedState(data)),
		);
	});

program
	.command("restart <name>")
	.description("Restart a service")
	.option("--json", "output the raw JSON payload instead of a receipt")
	.action(async (name: string, opts: { json?: boolean }) => {
		await renderDaemon({ cmd: "restart", name }, opts.json, (data) =>
			formatActionReceipt("restarted", name, landedState(data)),
		);
	});

program
	.command("resume <name>")
	.description("Resume a budget-paused service, optionally overriding its caps for the current window")
	.option("--daily <usd|none>", 'set the daily USD cap this window, or "none" to lift it')
	.option("--weekly <usd|none>", 'set the weekly USD cap this window, or "none" to lift it')
	.option("--daily-tokens <n|none>", 'set the daily token cap this window, or "none" to lift it')
	.option("--unlimited", "lift all caps for the current window")
	.option("--reset", "zero the current budget windows and resume under the configured caps")
	.option("--json", "output the raw JSON payload instead of a receipt")
	.action(async (name: string, opts: ResumeFlags & { json?: boolean }) => {
		let parsed: ReturnType<typeof parseResumeFlags>;
		try {
			parsed = parseResumeFlags(opts);
		} catch (err) {
			process.stderr.write(`pid: ${err instanceof Error ? err.message : String(err)}\n`);
			process.exitCode = 1;
			return;
		}
		await renderDaemon({ cmd: "resume", name, spec: parsed.spec, reset: parsed.reset }, opts.json, (data) =>
			formatActionReceipt("resumed", name, landedState(data)),
		);
	});

program
	.command("enable <name>")
	.description("Enable a service for auto-start on daemon boot")
	.option("--json", "output the raw JSON payload instead of a receipt")
	.action(async (name: string, opts: { json?: boolean }) => {
		await renderDaemon({ cmd: "enable", name }, opts.json, () => formatActionReceipt("enabled", name));
	});

program
	.command("disable <name>")
	.description("Disable auto-start for a service")
	.option("--json", "output the raw JSON payload instead of a receipt")
	.action(async (name: string, opts: { json?: boolean }) => {
		await renderDaemon({ cmd: "disable", name }, opts.json, () => formatActionReceipt("disabled", name));
	});

program
	.command("logs <name>")
	.description("Show a service's event log (lifecycle events; --raw for the JSONL chronicle)")
	.option("-f, --follow", "follow new events as they arrive")
	.option("--raw", "emit the raw JSONL chronicle instead of the rendered line view")
	.option("--since <when>", "only events at/after <when> (e.g. 30m, 2h, 7d, or an ISO timestamp)")
	.option("--type <type>", "only events of this type (e.g. tool_execution_start, pid_approval)")
	.option("--source <pi|pid>", "only events from this source")
	.action(async (name: string, opts: LogsFlags) => {
		await runLogs(name, opts);
	});

program
	.command("tail")
	.description(
		"Follow the live event stream of all services at once (picks up new services), each line tagged by service",
	)
	.option("--raw", "emit the raw JSONL chronicle instead of the rendered line view")
	.option("--type <type>", "only events of this type")
	.option("--source <pi|pid>", "only events from this source")
	.action(async (opts: LogsFlags) => {
		await runTail(opts);
	});

program
	.command("reload")
	.description("Re-read service files from disk and reconcile (never interrupts a running service)")
	.option("--json", "output the raw JSON payload instead of a summary")
	.action(async (opts: { json?: boolean }) => {
		await renderDaemon({ cmd: "reload" }, opts.json, (data) => formatReloadSummary(data as ReloadSummary));
	});

program
	.command("approvals")
	.description("List pending approval requests")
	.option("--json", "output the raw JSON payload instead of the table")
	.action(async (opts: { json?: boolean }) => {
		await renderDaemon({ cmd: "approvals" }, opts.json, (data) =>
			formatApprovalsTable(data as PendingApproval[], Date.now()),
		);
	});

program
	.command("approve <id>")
	.description("Approve a pending request (id or unique prefix); prompts for a value if needed")
	.option("--value <value>", "value for select/input/editor (skips the interactive prompt)")
	.option("--json", "output the raw JSON payload instead of a receipt")
	.action(async (id: string, opts: { value?: string; json?: boolean }) => {
		let fullId: string;
		let value = opts.value;
		try {
			const entry = resolveApprovalId(id, await fetchApprovals());
			fullId = entry.id;
			// Gather a value interactively when one is needed and none was supplied. --json is the
			// machine path: never prompt — let the daemon's --value floor reject a missing value.
			if (value === undefined && entry.method !== "confirm" && !opts.json) {
				value = await promptValue(entry);
			}
		} catch (err) {
			process.stderr.write(
				`pid: ${err instanceof ValueEntryCancelled ? `cancelled — '${id}' still pending` : errMsg(err)}\n`,
			);
			process.exitCode = 1;
			return;
		}
		await renderDaemon({ cmd: "approve", id: fullId, value }, opts.json, (data) =>
			formatApproveReceipt(data as PendingApproval, value),
		);
	});

program
	.command("deny <id>")
	.description("Deny a pending request (id or unique prefix)")
	.option("--reason <reason>", "reason for denial")
	.option("--json", "output the raw JSON payload instead of a receipt")
	.action(async (id: string, opts: { reason?: string; json?: boolean }) => {
		let fullId: string;
		try {
			fullId = resolveApprovalId(id, await fetchApprovals()).id;
		} catch (err) {
			process.stderr.write(`pid: ${errMsg(err)}\n`);
			process.exitCode = 1;
			return;
		}
		await renderDaemon({ cmd: "deny", id: fullId, reason: opts.reason }, opts.json, (data) =>
			formatDenyReceipt(data as PendingApproval),
		);
	});

const budget = program.command("budget").description("Inspect or reset service budgets");
budget
	.command("show <name>")
	.description("Show budget consumed for a service")
	.option("--json", "output the raw JSON payload instead of the rendered view")
	.action(async (name: string, opts: { json?: boolean }) => {
		await renderDaemon({ cmd: "budget_show", name }, opts.json, (data) => formatBudget(data as BudgetView, name));
	});
budget
	.command("reset <name>")
	.description("Force budget window reset (accounting only; use `pid resume` to run a paused service)")
	.option("--json", "output the raw JSON payload instead of the rendered view")
	.action(async (name: string, opts: { json?: boolean }) => {
		await renderDaemon(
			{ cmd: "budget_reset", name },
			opts.json,
			(data) => `✓ budget reset ${name}\n${formatBudget(data as BudgetView, name)}`,
		);
	});

program
	.command("quarantine <name>")
	.description("Manually quarantine a service")
	.option("--json", "output the raw JSON payload instead of a receipt")
	.action(async (name: string, opts: { json?: boolean }) => {
		await renderDaemon({ cmd: "quarantine", name }, opts.json, () => formatActionReceipt("quarantined", name));
	});

program
	.command("unquarantine <name>")
	.description("Lift quarantine; allow restart")
	.option("--json", "output the raw JSON payload instead of a receipt")
	.action(async (name: string, opts: { json?: boolean }) => {
		await renderDaemon({ cmd: "unquarantine", name }, opts.json, () => formatActionReceipt("unquarantined", name));
	});

/** Build the chronicle filter from `pid logs` flags; throws on a bad `--source`/`--since`. */
function buildLogFilter(opts: LogsFlags): LogFilter {
	const filter: LogFilter = {};
	if (opts.since) filter.since = parseSince(opts.since, new Date());
	if (opts.type) filter.type = opts.type;
	if (opts.source) {
		if (opts.source !== "pi" && opts.source !== "pid") {
			throw new Error(`invalid --source: "${opts.source}" (expected "pi" or "pid")`);
		}
		filter.source = opts.source;
	}
	return filter;
}

/**
 * `pid logs <name>` — read the service's chronicle (archives + live, stitched) directly off disk
 * (ADR 0008, daemon-free), rendering the lean line view (or raw JSONL with `--raw`). With `-f`, keep
 * following the live file from its current end after printing history.
 */
async function runLogs(name: string, opts: LogsFlags): Promise<void> {
	let filter: LogFilter;
	try {
		filter = buildLogFilter(opts);
	} catch (err) {
		process.stderr.write(`pid: ${errMsg(err)}\n`);
		process.exitCode = 1;
		return;
	}

	const dir = logsDir();
	let lastDay: string | undefined;
	let count = 0;
	const emit = (env: LogEnvelope): void => {
		count += 1;
		if (opts.raw) {
			process.stdout.write(`${JSON.stringify(env)}\n`);
			return;
		}
		const day = logDay(env);
		if (day !== lastDay) {
			process.stdout.write(`${count === 1 ? "" : "\n"}── ${day} ──\n`);
			lastDay = day;
		}
		process.stdout.write(`${formatLogLine(env)}\n`);
	};

	try {
		await readChronicle(dir, name, filter, emit);
	} catch (err) {
		process.stderr.write(`pid: ${errMsg(err)}\n`);
		process.exitCode = 1;
		return;
	}

	if (!opts.follow) {
		if (count === 0) process.stderr.write(`pid: no matching events for ${name}\n`);
		return;
	}

	// Follow: render each new matching line appended to the live file (history above already printed it).
	const tailer = new FileTailer(join(dir, `${name}.jsonl`), (raw) => {
		let env: LogEnvelope;
		try {
			env = JSON.parse(raw) as LogEnvelope;
		} catch {
			return; // skip a corrupt line, keep following
		}
		if (matchesFilter(env, filter)) emit(env);
	});
	tailer.start();
	process.on("SIGINT", () => {
		tailer.stop();
		process.exit(0);
	});
}

/**
 * `pid tail` — follow every service's live chronicle at once (ADR 0008), interleaved in arrival order
 * and prefixed by service name. Daemon-free: one FileTailer per live file. New events only (it's a live
 * monitor, not history).
 *
 * The follow-set is **dynamic** (ADR 0008, amended 2026-06-07): `pid tail` is a long-lived monitor, so a
 * service that first starts *after* launch must be picked up — otherwise its events stay invisible until
 * a re-run, and a dashboard built on `pid tail --raw` would silently miss them. So instead of a fixed
 * set captured at startup, it re-scans the logs dir on an interval (polling, mirroring FileTailer — not
 * `fs.watch`, whose rename/inode flakiness ADR 0008 deliberately avoids) and attaches any new file. A
 * file present at launch is followed live (no history replay — it's a monitor); a file that *appears*
 * later is brand-new, so it is read from its start (small, no flood) and announced like `tail -F`'s
 * "has appeared; following". Status notices go to **stderr** so stdout stays a pure event stream
 * (`pid tail --raw | jq`, the dashboard facade). An empty start waits rather than erroring out.
 */
async function runTail(opts: LogsFlags): Promise<void> {
	let filter: LogFilter;
	try {
		filter = buildLogFilter(opts);
	} catch (err) {
		process.stderr.write(`pid: ${errMsg(err)}\n`);
		process.exitCode = 1;
		return;
	}

	const dir = logsDir();
	const tailers = new Map<string, FileTailer>();
	let serviceWidth = 0; // widens as services attach; the emit closure reads it live (late arrivals align)

	const attach = (name: string, path: string, fromStart: boolean): void => {
		if (tailers.has(name)) return;
		serviceWidth = Math.max(serviceWidth, name.length);
		const tailer = new FileTailer(
			path,
			(raw) => {
				if (opts.raw) {
					process.stdout.write(`${raw}\n`); // the envelope already carries `service`
					return;
				}
				let env: LogEnvelope;
				try {
					env = JSON.parse(raw) as LogEnvelope;
				} catch {
					return;
				}
				if (matchesFilter(env, filter)) {
					process.stdout.write(`${formatLogLine(env, { withService: true, serviceWidth })}\n`);
				}
			},
			{ fromStart },
		);
		tailer.start();
		tailers.set(name, tailer);
	};

	// Services already logging at launch: follow live (no history replay on a monitor).
	const initial = await listLiveServices(dir);
	for (const s of initial) attach(s.name, s.path, false);
	if (initial.length === 0) process.stderr.write("pid: no services logging yet — waiting… (Ctrl-C to quit)\n");

	// Pick up services that begin logging later, reading each from its start so its boot isn't missed.
	const rescanOnce = async (): Promise<void> => {
		for (const s of await listLiveServices(dir)) {
			if (!tailers.has(s.name)) {
				process.stderr.write(`pid: following ${s.name}\n`);
				attach(s.name, s.path, true);
			}
		}
	};
	const rescan = setInterval(() => void rescanOnce(), 1000);

	process.on("SIGINT", () => {
		clearInterval(rescan);
		for (const tailer of tailers.values()) tailer.stop();
		process.exit(0);
	});
}

/**
 * Send a command and present the result the ADR-0006 way: a daemon error → plain stderr + exit 1;
 * `--json` → the raw `data` payload; otherwise the human-readable `render(data)`. The seed of the
 * convention D2 generalises across every command.
 */
async function renderDaemon(req: Request, json: boolean | undefined, render: (data: unknown) => string): Promise<void> {
	try {
		const socket = await connect();
		const response = await sendCommand(socket, req);
		socket.end();
		if (!response.ok) {
			process.stderr.write(`pid: ${response.error}\n`);
			process.exitCode = 1;
			return;
		}
		process.stdout.write(json ? `${JSON.stringify(response.data, null, 2)}\n` : `${render(response.data)}\n`);
	} catch (err) {
		process.stderr.write(`pid: ${err instanceof Error ? err.message : String(err)}\n`);
		process.exitCode = 1;
	}
}

// Guard so the parser/commands can be imported in tests without executing argv (mirrors daemon.ts).
if (import.meta.url === `file://${process.argv[1]}`) {
	// A downstream reader closing the pipe early (`pid logs … | head`, `| grep -m1`, quitting `less`)
	// makes the next stdout write EPIPE; that's a normal end-of-consumer, not an error — exit quietly.
	process.stdout.on("error", (err: NodeJS.ErrnoException) => {
		if (err.code === "EPIPE") process.exit(0);
		throw err;
	});
	program.parseAsync(process.argv);
}
