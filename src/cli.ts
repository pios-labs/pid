#!/usr/bin/env node
import { Command } from "commander";
import type { PendingApproval } from "./approvals/router.js";
import {
	formatActionReceipt,
	formatApprovalsTable,
	formatApproveReceipt,
	formatDenyReceipt,
	formatStatus,
} from "./cli-render.js";
import { runDaemon } from "./daemon.js";
import { connect, type Request, sendCommand } from "./protocol/socket.js";
import { parseResumeFlags, type ResumeFlags } from "./services/resume-args.js";
import type { ServiceStatus } from "./supervisor/index.js";

/** Narrow the action-command payload (`{ name, state }`) for the receipt's `→ <state>`. */
function landedState(data: unknown): string | undefined {
	return (data as { state?: string } | undefined)?.state;
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
	.description("Show service logs")
	.option("-f, --follow", "follow log output")
	.option("--raw", "show raw JSONL instead of turn-grouped view")
	.action(async (name: string, opts: { follow?: boolean; raw?: boolean }) => {
		await callDaemon({ cmd: "logs", name, follow: opts.follow, raw: opts.raw });
	});

program
	.command("tail")
	.description("Live multiplexed event stream from all running services")
	.action(async () => {
		await callDaemon({ cmd: "tail" });
	});

program
	.command("reload")
	.description("Re-read service files from disk")
	.action(async () => {
		await callDaemon({ cmd: "reload" });
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
	.description("Approve a pending request; supply --value for select/input/editor")
	.option("--value <value>", "value for select/input/editor requests")
	.option("--json", "output the raw JSON payload instead of a receipt")
	.action(async (id: string, opts: { value?: string; json?: boolean }) => {
		await renderDaemon({ cmd: "approve", id, value: opts.value }, opts.json, (data) =>
			formatApproveReceipt(data as PendingApproval, opts.value),
		);
	});

program
	.command("deny <id>")
	.description("Deny a pending request")
	.option("--reason <reason>", "reason for denial")
	.option("--json", "output the raw JSON payload instead of a receipt")
	.action(async (id: string, opts: { reason?: string; json?: boolean }) => {
		await renderDaemon({ cmd: "deny", id, reason: opts.reason }, opts.json, (data) =>
			formatDenyReceipt(data as PendingApproval),
		);
	});

const budget = program.command("budget").description("Inspect or reset service budgets");
budget
	.command("show <name>")
	.description("Show budget consumed for a service")
	.action(async (name: string) => {
		await callDaemon({ cmd: "budget_show", name });
	});
budget
	.command("reset <name>")
	.description("Force budget window reset")
	.action(async (name: string) => {
		await callDaemon({ cmd: "budget_reset", name });
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

async function callDaemon(req: Request): Promise<void> {
	try {
		const socket = await connect();
		const response = await sendCommand(socket, req);
		process.stdout.write(`${JSON.stringify(response, null, 2)}\n`);
		socket.end();
	} catch (err) {
		const message = err instanceof Error ? err.message : String(err);
		process.stderr.write(`pid: ${message}\n`);
		process.exitCode = 1;
	}
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
	program.parseAsync(process.argv);
}
