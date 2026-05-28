import { homedir } from "node:os";
import { join } from "node:path";

const HOME = homedir();
const PI_HOME = process.env.PI_HOME ?? join(HOME, ".pi");
const PID_HOME = process.env.PID_HOME ?? join(PI_HOME, "pid");

export function pidHome(): string {
	return PID_HOME;
}

export function servicesDir(): string {
	return join(PID_HOME, "services");
}

export function stateDir(): string {
	return PID_HOME;
}

export function logsDir(): string {
	return join(PID_HOME, "logs");
}

export function approvalsDir(): string {
	return join(PID_HOME, "approvals");
}

export function budgetDir(): string {
	return join(PID_HOME, "budget");
}

export function socketPath(): string {
	return process.env.PID_SOCKET ?? join(PID_HOME, "pid.sock");
}
