#!/usr/bin/env node
import { Command } from "commander";
import { connect, sendCommand, type Request } from "./protocol/socket.js";
import { runDaemon } from "./daemon.js";

const VERSION = "0.0.1";

const program = new Command();

program
	.name("pid")
	.description("Supervisor for pi agents")
	.version(VERSION, "-v, --version");

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
	.action(async () => {
		await callDaemon({ cmd: "list" });
	});

program
	.command("status [name]")
	.description("Show status for one or all services")
	.action(async (name?: string) => {
		await callDaemon({ cmd: "status", name });
	});

program
	.command("start <name>")
	.description("Start a stopped service")
	.action(async (name: string) => {
		await callDaemon({ cmd: "start", name });
	});

program
	.command("stop <name>")
	.description("Stop a running service")
	.action(async (name: string) => {
		await callDaemon({ cmd: "stop", name });
	});

program
	.command("restart <name>")
	.description("Restart a service")
	.action(async (name: string) => {
		await callDaemon({ cmd: "restart", name });
	});

program
	.command("enable <name>")
	.description("Enable a service for auto-start on daemon boot")
	.action(async (name: string) => {
		await callDaemon({ cmd: "enable", name });
	});

program
	.command("disable <name>")
	.description("Disable auto-start for a service")
	.action(async (name: string) => {
		await callDaemon({ cmd: "disable", name });
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
	.action(async () => {
		await callDaemon({ cmd: "approvals" });
	});

program
	.command("approve <id>")
	.description("Approve a pending request")
	.option("--value <value>", "value for select/input requests")
	.action(async (id: string, opts: { value?: string }) => {
		await callDaemon({ cmd: "approve", id, value: opts.value });
	});

program
	.command("deny <id>")
	.description("Deny a pending request")
	.option("--reason <reason>", "reason for denial")
	.action(async (id: string, opts: { reason?: string }) => {
		await callDaemon({ cmd: "deny", id, reason: opts.reason });
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
	.action(async (name: string) => {
		await callDaemon({ cmd: "quarantine", name });
	});

program
	.command("unquarantine <name>")
	.description("Lift quarantine; allow restart")
	.action(async (name: string) => {
		await callDaemon({ cmd: "unquarantine", name });
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

program.parseAsync(process.argv);
