#!/usr/bin/env node
// pid dashboard facade — an HTTP+SSE+POST mirror of the pid CLI.
//
// This is the example dashboard's server (ADR 0011 + docs/dashboard-api.md). It is the *deliverable*:
// a documented HTTP surface that any browser, remote dashboard, or embedded widget can consume. The
// bundled UI is just its first client.
//
// PURE CLI CONSUMER (ADR 0011 §2): it obtains all data and performs all actions by shelling the
// documented `pid` CLI — `pid tail --raw` for the live stream, `pid … --json` for snapshots/actions.
// It imports NOTHING from pid's src/. If it ever needs something the CLI can't give, that's a CLI gap
// to fix, not a shortcut to take here. So it is reimplementable in any language by shelling the same
// commands.
//
// Build-free: Node built-ins only (http, child_process, fs, path, url). No framework, no bundler.
// It is a separate process, never the daemon (ADR 0008 D1).

import { spawn } from "node:child_process";
import { readFile } from "node:fs/promises";
import { createServer } from "node:http";
import { dirname, extname, join, normalize } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const API_VERSION = 1;

// ────────────────────────────────────────────────────────────────────────────
// Config
// ────────────────────────────────────────────────────────────────────────────

/** Parse argv + env into the server config. The `pid dashboard` launcher passes the same flags. */
function parseConfig(argv) {
	const cfg = {
		port: 7878,
		host: "127.0.0.1",
		readOnly: false,
		allowOrigins: [],
		pidBin: process.env.PID_BIN || "pid",
		pollMs: 1500,
	};
	for (let i = 0; i < argv.length; i++) {
		const arg = argv[i];
		if (arg === "--port") cfg.port = Number(argv[++i]);
		else if (arg === "--host") cfg.host = argv[++i];
		else if (arg === "--read-only") cfg.readOnly = true;
		else if (arg === "--allow-origin") cfg.allowOrigins.push(argv[++i]);
		else if (arg === "--pid-bin") cfg.pidBin = argv[++i];
		else if (arg === "--poll-ms") cfg.pollMs = Number(argv[++i]);
		else throw new Error(`unknown flag: ${arg}`);
	}
	if (!Number.isInteger(cfg.port) || cfg.port < 1 || cfg.port > 65535) {
		throw new Error(`invalid --port: ${cfg.port}`);
	}
	return cfg;
}

// ────────────────────────────────────────────────────────────────────────────
// pid CLI bridge — the only way this server touches pid
// ────────────────────────────────────────────────────────────────────────────

/** Run `pid <args> --json` and return the daemon's `{ok, data}` / `{ok:false, error}` shape. */
function pidJson(cfg, args) {
	return new Promise((resolve) => {
		const child = spawn(cfg.pidBin, [...args, "--json"], { stdio: ["ignore", "pipe", "pipe"] });
		let out = "";
		let err = "";
		child.stdout.on("data", (b) => {
			out += b;
		});
		child.stderr.on("data", (b) => {
			err += b;
		});
		child.on("error", (e) => resolve({ ok: false, error: `cannot run ${cfg.pidBin}: ${e.message}` }));
		child.on("close", (code) => {
			if (code === 0) {
				try {
					resolve({ ok: true, data: out.trim() ? JSON.parse(out) : null });
				} catch (e) {
					resolve({ ok: false, error: `bad JSON from pid: ${e.message}` });
				}
			} else {
				// The CLI prints `pid: <message>` to stderr on failure (ADR 0006). Strip the prefix.
				resolve({ ok: false, error: err.trim().replace(/^pid:\s*/, "") || `pid exited ${code}` });
			}
		});
	});
}

// ────────────────────────────────────────────────────────────────────────────
// Live state: the snapshot poller + the chronicle stream
// ────────────────────────────────────────────────────────────────────────────

/**
 * Poll the CLI for current state on an interval and push it to every SSE client. This is what makes the
 * dashboard a *monitor*: a crash-quarantine, an auto budget-pause, or a new approval appears with no user
 * action (ADR 0011 §3). Snapshot = { services, approvals, budgets } — run-state and the live inbox are
 * not in the chronicle (they live in the daemon), so a poll is required.
 */
async function buildSnapshot(cfg) {
	const [services, approvals] = await Promise.all([pidJson(cfg, ["list"]), pidJson(cfg, ["approvals"])]);
	const serviceList = services.ok ? (services.data ?? []) : [];
	const budgets = {};
	// Only budgeted services have a budget view; asking for others would error.
	for (const s of serviceList) {
		if (s.config?.budget) {
			const r = await pidJson(cfg, ["budget", "show", s.name]);
			if (r.ok) budgets[s.name] = r.data;
		}
	}
	return {
		services: serviceList,
		approvals: approvals.ok ? (approvals.data ?? []) : [],
		budgets,
	};
}

/**
 * Follow every service's live chronicle via `pid tail --raw`, emitting one parsed envelope per line.
 *
 * `pid tail` self-discovers: it waits when no service is logging yet and picks up services that start
 * later (ADR 0008, amended) — so the facade just spawns it once and forwards. The respawn-on-exit guard
 * is only a safety net for an unexpected crash/kill of the tail process, not part of normal operation.
 */
function startLogStream(cfg, onEnvelope) {
	let child = null;
	let stopped = false;

	const spawnTail = () => {
		if (stopped) return;
		child = spawn(cfg.pidBin, ["tail", "--raw"], { stdio: ["ignore", "pipe", "ignore"] });
		let buf = "";
		child.stdout.on("data", (chunk) => {
			buf += chunk;
			let nl = buf.indexOf("\n");
			while (nl !== -1) {
				const line = buf.slice(0, nl).trimEnd();
				buf = buf.slice(nl + 1);
				if (line) {
					try {
						onEnvelope(JSON.parse(line));
					} catch {
						/* skip a corrupt line, keep streaming */
					}
				}
				nl = buf.indexOf("\n");
			}
		});
		const restart = () => {
			child = null;
			if (!stopped) setTimeout(spawnTail, 1000);
		};
		child.on("close", restart);
		child.on("error", restart);
	};

	spawnTail();

	return {
		stop() {
			stopped = true;
			if (child) child.kill();
		},
	};
}

// ────────────────────────────────────────────────────────────────────────────
// SSE fan-out
// ────────────────────────────────────────────────────────────────────────────

/** Hub of connected SSE clients. One named-event channel carries `snapshot` and `log` (ADR 0011 §3). */
function createHub() {
	const clients = new Set();
	const send = (res, event, data) => {
		res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
	};
	return {
		add(res) {
			clients.add(res);
		},
		remove(res) {
			clients.delete(res);
		},
		broadcast(event, data) {
			for (const res of clients) {
				try {
					send(res, event, data);
				} catch {
					clients.delete(res);
				}
			}
		},
		send,
		get size() {
			return clients.size;
		},
	};
}

// ────────────────────────────────────────────────────────────────────────────
// Security floor (always on — ADR 0011 §4)
// ────────────────────────────────────────────────────────────────────────────

const LOOPBACK = new Set(["127.0.0.1", "localhost", "::1", "[::1]"]);

/** Hostname of a `Host:`/`Origin:` value, port stripped. */
function hostnameOf(value) {
	try {
		return new URL(value.includes("://") ? value : `http://${value}`).hostname;
	} catch {
		return value.replace(/:\d+$/, "");
	}
}

/**
 * Enforce the always-on floor: a Host that is not the bound host/loopback is rejected (defeats
 * DNS-rebinding), and an Origin that is neither same-origin nor allowlisted is rejected (defeats
 * localhost-CSRF from a random page). Returns { ok } and, for an allowlisted cross-origin request, the
 * `corsOrigin` to echo back. Same-origin requests need no CORS header.
 */
function guard(cfg, req) {
	const host = req.headers.host || "";
	const hostName = hostnameOf(host);
	if (hostName !== cfg.host && !LOOPBACK.has(hostName)) {
		return { ok: false, status: 403, reason: `host not allowed: ${host}` };
	}
	const origin = req.headers.origin;
	if (!origin) return { ok: true }; // curl / same-origin navigation — no Origin to vet
	if (hostnameOf(origin) === hostName) return { ok: true }; // same-origin
	if (cfg.allowOrigins.includes(origin)) return { ok: true, corsOrigin: origin };
	return { ok: false, status: 403, reason: `origin not allowed: ${origin}` };
}

// ────────────────────────────────────────────────────────────────────────────
// HTTP handlers
// ────────────────────────────────────────────────────────────────────────────

function sendJson(res, status, payload, extraHeaders = {}) {
	const body = JSON.stringify(payload);
	res.writeHead(status, { "content-type": "application/json; charset=utf-8", ...extraHeaders });
	res.end(body);
}

/** Map a CLI `{ok,data|error}` result to an HTTP response (action endpoints — ADR docs §Action). */
function sendCliResult(res, result, cors) {
	const headers = cors ? { "access-control-allow-origin": cors, vary: "Origin" } : {};
	if (result.ok) sendJson(res, 200, { ok: true, data: result.data }, headers);
	else sendJson(res, 400, { ok: false, error: result.error }, headers);
}

const STATIC_TYPES = {
	".html": "text/html; charset=utf-8",
	".js": "text/javascript; charset=utf-8",
	".mjs": "text/javascript; charset=utf-8",
	".css": "text/css; charset=utf-8",
	".svg": "image/svg+xml",
	".ico": "image/x-icon",
};

/** Serve a bundled static asset (the UI + web component) from this directory, path-traversal-safe. */
async function serveStatic(res, urlPath) {
	const rel = normalize(urlPath === "/" ? "/index.html" : urlPath).replace(/^(\.\.[/\\])+/, "");
	const file = join(HERE, rel);
	if (!file.startsWith(HERE)) {
		sendJson(res, 403, { ok: false, error: "forbidden" });
		return;
	}
	try {
		const body = await readFile(file);
		res.writeHead(200, { "content-type": STATIC_TYPES[extname(file)] || "application/octet-stream" });
		res.end(body);
	} catch {
		if (urlPath === "/") {
			res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
			res.end(
				"<!doctype html><meta charset=utf-8><title>pid dashboard</title>" +
					"<body style='font:14px system-ui;padding:2rem;max-width:40rem;color:#ddd;background:#111'>" +
					"<h1>pid dashboard facade</h1><p>The API is live. The bundled UI (<code>index.html</code>) " +
					"is not present yet.</p><p>Try <code>GET /api/version</code>, <code>/api/services</code>, " +
					"or the <code>/api/events</code> SSE stream. See <code>docs/dashboard-api.md</code>.</p>",
			);
		} else {
			sendJson(res, 404, { ok: false, error: "not found" });
		}
	}
}

/** Read and JSON-parse a request body (for POSTs that take options). Empty body → {}. */
function readBody(req) {
	return new Promise((resolve) => {
		let buf = "";
		req.on("data", (c) => {
			buf += c;
		});
		req.on("end", () => {
			if (!buf.trim()) return resolve({});
			try {
				resolve(JSON.parse(buf));
			} catch {
				resolve(null); // signals a malformed body
			}
		});
	});
}

/** Translate a POST action route + body into pid CLI args, or null if the route is unknown. */
function actionArgs(segs, body) {
	// segs is the path under /api, e.g. ["services","scraper","stop"]
	if (segs[0] === "services" && segs.length === 3) {
		const name = segs[1];
		const verb = segs[2];
		if (["start", "stop", "restart", "enable", "disable", "quarantine", "unquarantine"].includes(verb)) {
			return [verb, name];
		}
		if (verb === "resume") {
			const args = ["resume", name];
			if (body.daily !== undefined) args.push("--daily", String(body.daily));
			if (body.weekly !== undefined) args.push("--weekly", String(body.weekly));
			if (body.dailyTokens !== undefined) args.push("--daily-tokens", String(body.dailyTokens));
			if (body.unlimited) args.push("--unlimited");
			if (body.reset) args.push("--reset");
			return args;
		}
	}
	if (segs[0] === "budget" && segs.length === 3 && segs[2] === "reset") return ["budget", "reset", segs[1]];
	if (segs[0] === "approvals" && segs.length === 3) {
		const id = segs[1];
		if (segs[2] === "approve")
			return body.value !== undefined ? ["approve", id, "--value", String(body.value)] : ["approve", id];
		if (segs[2] === "deny")
			return body.reason !== undefined ? ["deny", id, "--reason", String(body.reason)] : ["deny", id];
	}
	if (segs[0] === "reload" && segs.length === 1) return ["reload"];
	return null;
}

// ────────────────────────────────────────────────────────────────────────────
// Server
// ────────────────────────────────────────────────────────────────────────────

function start(cfg) {
	const hub = createHub();
	let lastSnapshot = { services: [], approvals: [], budgets: {} };

	const stream = startLogStream(cfg, (env) => hub.broadcast("log", env));

	const poll = async () => {
		try {
			lastSnapshot = await buildSnapshot(cfg);
			hub.broadcast("snapshot", lastSnapshot);
		} catch {
			/* a transient CLI hiccup — next tick retries */
		}
	};
	const timer = setInterval(poll, cfg.pollMs);
	poll();

	const server = createServer(async (req, res) => {
		const url = new URL(req.url, `http://${req.headers.host || cfg.host}`);
		const path = url.pathname;

		const g = guard(cfg, req);
		if (!g.ok) {
			sendJson(res, g.status, { ok: false, error: g.reason });
			return;
		}
		const cors = g.corsOrigin;
		const corsHeaders = cors ? { "access-control-allow-origin": cors, vary: "Origin" } : {};

		// CORS preflight for an allowlisted embed origin.
		if (req.method === "OPTIONS") {
			res.writeHead(cors ? 204 : 403, {
				...corsHeaders,
				"access-control-allow-methods": "GET, POST, OPTIONS",
				"access-control-allow-headers": "content-type",
			});
			res.end();
			return;
		}

		// Non-API: serve the bundled UI / assets.
		if (!path.startsWith("/api")) {
			await serveStatic(res, path);
			return;
		}

		const segs = path
			.replace(/^\/api\/?/, "")
			.split("/")
			.filter(Boolean);

		// ── GET: reads + the SSE stream ──
		if (req.method === "GET") {
			if (segs[0] === "version") {
				return sendJson(res, 200, { pid: await pidVersion(cfg), api: API_VERSION, readOnly: cfg.readOnly }, corsHeaders);
			}
			if (segs[0] === "events") return openEventStream(req, res, hub, lastSnapshot, corsHeaders);
			if (segs[0] === "services" && segs.length === 1) {
				const r = await pidJson(cfg, ["list"]);
				return r.ok
					? sendJson(res, 200, r.data, corsHeaders)
					: sendJson(res, 502, { ok: false, error: r.error }, corsHeaders);
			}
			if (segs[0] === "services" && segs.length === 2) {
				const r = await pidJson(cfg, ["status", segs[1]]);
				return r.ok
					? sendJson(res, 200, r.data, corsHeaders)
					: sendJson(res, 404, { ok: false, error: r.error }, corsHeaders);
			}
			if (segs[0] === "approvals" && segs.length === 1) {
				const r = await pidJson(cfg, ["approvals"]);
				return r.ok
					? sendJson(res, 200, r.data, corsHeaders)
					: sendJson(res, 502, { ok: false, error: r.error }, corsHeaders);
			}
			if (segs[0] === "budget" && segs.length === 2) {
				const r = await pidJson(cfg, ["budget", "show", segs[1]]);
				if (r.ok) return sendJson(res, 200, r.data, corsHeaders);
				const status = /has no budget/.test(r.error) ? 404 : 502;
				return sendJson(res, status, { ok: false, error: r.error }, corsHeaders);
			}
			return sendJson(res, 404, { ok: false, error: "not found" }, corsHeaders);
		}

		// ── POST: actions ──
		if (req.method === "POST") {
			if (cfg.readOnly) return sendJson(res, 403, { ok: false, error: "read-only mode" }, corsHeaders);
			const body = await readBody(req);
			if (body === null) return sendJson(res, 400, { ok: false, error: "malformed JSON body" }, corsHeaders);
			const args = actionArgs(segs, body);
			if (!args) return sendJson(res, 404, { ok: false, error: "not found" }, corsHeaders);
			return sendCliResult(res, await pidJson(cfg, args), cors);
		}

		sendJson(res, 405, { ok: false, error: "method not allowed" }, corsHeaders);
	});

	server.on("close", () => {
		clearInterval(timer);
		stream.stop();
	});
	server.listen(cfg.port, cfg.host, () => {
		const mode = cfg.readOnly ? " (read-only)" : "";
		process.stdout.write(`pid dashboard facade on http://${cfg.host}:${cfg.port}${mode}\n`);
		if (cfg.allowOrigins.length) process.stdout.write(`  embedding allowed from: ${cfg.allowOrigins.join(", ")}\n`);
	});
	return server;
}

/** `pid --version` prints a plain string (no `--json`); capture it raw for `/api/version`. */
function pidVersion(cfg) {
	return new Promise((resolve) => {
		const child = spawn(cfg.pidBin, ["--version"], { stdio: ["ignore", "pipe", "ignore"] });
		let out = "";
		child.stdout.on("data", (b) => {
			out += b;
		});
		child.on("error", () => resolve("unknown"));
		child.on("close", () => resolve(out.trim() || "unknown"));
	});
}

/** Open an SSE connection: send the current snapshot immediately, then live snapshot/log events. */
function openEventStream(req, res, hub, lastSnapshot, corsHeaders) {
	res.writeHead(200, {
		"content-type": "text/event-stream",
		"cache-control": "no-cache",
		connection: "keep-alive",
		...corsHeaders,
	});
	res.write(": connected\n\n");
	hub.send(res, "snapshot", lastSnapshot); // current state on connect (ADR 0011 §3)
	hub.add(res);
	const keepAlive = setInterval(() => res.write(": ping\n\n"), 25000);
	req.on("close", () => {
		clearInterval(keepAlive);
		hub.remove(res);
	});
}

// ────────────────────────────────────────────────────────────────────────────

if (import.meta.url === `file://${process.argv[1]}`) {
	let cfg;
	try {
		cfg = parseConfig(process.argv.slice(2));
	} catch (e) {
		process.stderr.write(`pid-dashboard: ${e.message}\n`);
		process.exit(1);
	}
	start(cfg);
}

export { parseConfig, guard, actionArgs, hostnameOf };
