import { unlink } from "node:fs/promises";
import { createConnection, createServer, type Server, type Socket } from "node:net";
import { socketPath } from "../util/paths.js";

export interface Request {
	id?: string;
	cmd: string;
	[key: string]: unknown;
}

export interface Response {
	id?: string;
	ok: boolean;
	data?: unknown;
	error?: string;
}

export type RequestHandler = (req: Request) => Promise<Response>;

export async function listen(path: string, handler: RequestHandler): Promise<Server> {
	await unlink(path).catch(() => {});

	const server = createServer((socket) => {
		let buffer = "";
		socket.on("data", async (chunk) => {
			buffer += chunk.toString("utf8");
			while (true) {
				const newlineIndex = buffer.indexOf("\n");
				if (newlineIndex === -1) break;
				const line = buffer.slice(0, newlineIndex).replace(/\r$/, "");
				buffer = buffer.slice(newlineIndex + 1);
				if (!line) continue;
				try {
					const req = JSON.parse(line) as Request;
					const res = await handler(req);
					socket.write(`${JSON.stringify(res)}\n`);
				} catch (err) {
					const message = err instanceof Error ? err.message : String(err);
					socket.write(`${JSON.stringify({ ok: false, error: `parse: ${message}` })}\n`);
				}
			}
		});
		socket.on("error", () => {});
	});

	await new Promise<void>((resolve, reject) => {
		server.once("error", reject);
		server.listen(path, () => resolve());
	});

	return server;
}

export async function connect(path: string = socketPath()): Promise<Socket> {
	return await new Promise<Socket>((resolve, reject) => {
		const socket = createConnection(path);
		socket.once("connect", () => resolve(socket));
		socket.once("error", (err) => {
			reject(new Error(`cannot connect to ${path}: ${err.message}. Is the daemon running?`));
		});
	});
}

export async function sendCommand(socket: Socket, req: Request): Promise<Response> {
	return await new Promise<Response>((resolve, reject) => {
		let buffer = "";
		socket.on("data", (chunk) => {
			buffer += chunk.toString("utf8");
			const newlineIndex = buffer.indexOf("\n");
			if (newlineIndex !== -1) {
				const line = buffer.slice(0, newlineIndex).replace(/\r$/, "");
				try {
					resolve(JSON.parse(line) as Response);
				} catch (err) {
					reject(new Error(`malformed response: ${err instanceof Error ? err.message : String(err)}`));
				}
			}
		});
		socket.on("error", reject);
		socket.write(`${JSON.stringify(req)}\n`);
	});
}
