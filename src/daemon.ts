import { mkdir } from "node:fs/promises";
import { dirname } from "node:path";
import { listen, type Request, type Response } from "./protocol/socket.js";
import { loadAllServices } from "./services/loader.js";
import { StateStore } from "./state/store.js";
import { type BudgetOverrideSpec, Supervisor } from "./supervisor/index.js";
import { socketPath, stateDir } from "./util/paths.js";

export async function runDaemon(): Promise<void> {
	await mkdir(stateDir(), { recursive: true });
	await mkdir(dirname(socketPath()), { recursive: true });

	const state = await StateStore.open();
	const services = await loadAllServices();
	const supervisor = new Supervisor({ state, services });
	await supervisor.init();

	const server = await listen(socketPath(), async (req) => handle(req, supervisor));

	const shutdown = async (signal: NodeJS.Signals) => {
		process.stdout.write(`pid: received ${signal}, shutting down\n`);
		await supervisor.shutdown();
		server.close();
		process.exit(0);
	};
	process.on("SIGINT", shutdown);
	process.on("SIGTERM", shutdown);

	process.stdout.write(`pid: daemon ready on ${socketPath()}\n`);
	await supervisor.startEnabled();
}

async function handle(req: Request, supervisor: Supervisor): Promise<Response> {
	const { id, cmd } = req;
	try {
		const data = await dispatch(cmd, req, supervisor);
		return { id, ok: true, data };
	} catch (err) {
		const message = err instanceof Error ? err.message : String(err);
		return { id, ok: false, error: message };
	}
}

async function dispatch(cmd: string, req: Request, supervisor: Supervisor): Promise<unknown> {
	switch (cmd) {
		case "list":
			return supervisor.list();
		case "status":
			return supervisor.status(req.name as string | undefined);
		case "start":
			return supervisor.start(req.name as string);
		case "stop":
			return supervisor.stop(req.name as string);
		case "restart":
			return supervisor.restart(req.name as string);
		case "resume":
			return supervisor.resumeWithOverride(req.name as string, req.spec as BudgetOverrideSpec, req.reset as boolean);
		case "enable":
			return supervisor.enable(req.name as string);
		case "disable":
			return supervisor.disable(req.name as string);
		case "quarantine":
			// quarantine() is the CrashActions action (returns void); compose a status for CLI feedback.
			await supervisor.quarantine(req.name as string);
			return supervisor.status(req.name as string);
		case "unquarantine":
			return supervisor.unquarantine(req.name as string);
		case "approvals":
			return supervisor.listApprovals();
		case "approve":
			return supervisor.approveRequest(req.id as string, req.value as string | undefined);
		case "deny":
			return supervisor.denyRequest(req.id as string, req.reason as string | undefined);
		// `logs` (and `tail`, in 2b) read the chronicle files directly client-side (ADR 0008) — never
		// reach the daemon. `reload`/`budget_*` remain unimplemented daemon ops.
		case "tail":
		case "reload":
		case "budget_show":
		case "budget_reset":
			throw new Error(`not implemented: ${cmd}`);
		default:
			throw new Error(`unknown command: ${cmd}`);
	}
}

if (import.meta.url === `file://${process.argv[1]}`) {
	runDaemon().catch((err) => {
		process.stderr.write(`pid: ${err instanceof Error ? err.message : String(err)}\n`);
		process.exit(1);
	});
}
