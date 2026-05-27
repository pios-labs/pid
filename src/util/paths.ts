import { homedir } from "node:os";
import { join } from "node:path";

const HOME = homedir();
const ROOT = process.env.PID_HOME ?? join(HOME, ".pi");

export function servicesDir(): string {
	return join(ROOT, "services");
}

export function stateDir(): string {
	return join(ROOT, "pid");
}

export function logsDir(): string {
	return join(stateDir(), "logs");
}

export function approvalsDir(): string {
	return join(stateDir(), "approvals");
}

export function budgetDir(): string {
	return join(stateDir(), "budget");
}

export function socketPath(): string {
	return process.env.PID_SOCKET ?? join(ROOT, "pid.sock");
}
