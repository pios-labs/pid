# pid dashboard API (the over-HTTP contract)

> Status: **proposed** (ADR 0011). This is the HTTP/SSE surface the example dashboard server exposes, and the contract any third-party dashboard or embedded widget consumes. It is a **sibling tier** to pid's on-box contract: everything here is a thin mirror of `pid … --json` (ADR 0006) and the per-service chronicle (ADR 0005). On the same host you can skip this API and call the CLI / read the files directly; the API exists so a **browser or a remote dashboard** can consume the same data over HTTP.

The example server in `examples/dashboard/` implements this by **shelling the pid CLI only** (no pid internals): `pid tail --raw` for the live stream, `pid … --json` for snapshots and actions (ADR 0011 §2). So this contract is reimplementable in any language by shelling the same commands.

## Conventions

- Base path: `/` (the static UI), API under `/api`. JSON bodies and responses are UTF-8.
- **Action responses mirror the CLI:** `{ "ok": true, "data": <payload> }` on success, `{ "ok": false, "error": "<message>" }` with a non-2xx status on failure — the same `data`/`error` the daemon returns to `--json`.
- **Read responses** return the payload directly (the same JSON `pid <cmd> --json` prints).
- Payload shapes are exactly the CLI `--json` shapes; see the cross-reference column below and the chronicle schema in `v0-spec.md` ("Log line schema").
- Contract is versioned: `GET /api/version` → `{ "pid": "<cli version>", "api": 1, "readOnly": <bool> }`. Breaking changes bump `api`; `readOnly` reflects the server's `--read-only` flag so a client can hide action controls (the server still enforces it with a 403 on any POST).

## Read endpoints (GET)

| Endpoint | Returns | Mirrors |
|-|-|-|
| `GET /api/services` | `ServiceStatus[]` | `pid list --json` |
| `GET /api/services/:name` | `ServiceStatus` | `pid status <name> --json` |
| `GET /api/approvals` | `PendingApproval[]` | `pid approvals --json` |
| `GET /api/budget/:name` | `BudgetView` (404 if the service has no budget) | `pid budget show <name> --json` |
| `GET /api/version` | `{ pid, api, readOnly }` | — |
| `GET /api/events` | SSE stream (see below) | `pid tail --raw` + the snapshot polls |

`ServiceStatus` (per ADR 0010 / 0006) includes: `name`, `state`, `pid?`, `startedAt?`, `lastFailure?`, `pendingApprovals`, `configChanged`, `orphaned?`, and the service `config`. `BudgetView` includes `caps`, `snapshot` (`spentUsdDay/Week`, `tokensDay`, `dayEnd`, `weekEnd`, `override?`), `paused`, `breachedCaps`.

## Live stream: `GET /api/events` (SSE, `text/event-stream`)

The single live feed. Two named event types, one channel:

- **`event: snapshot`** — current state, sent **once on connect** and then on every poll (~1–2 s). Data:
  ```json
  { "services": [ /* ServiceStatus */ ],
    "approvals": [ /* PendingApproval */ ],
    "budgets": { "<service>": { /* BudgetView */ } } }
  ```
  (`budgets` carries one entry per budgeted service.) This is what makes the dashboard a *monitor*: a crash-quarantine, an auto budget-pause, or a new approval appears without any user action.
- **`event: log`** — one chronicle envelope per live event, as it is written (from `pid tail --raw`). Data is a single `LogEnvelope` (`{ v, ts, service, source, type, data }`). Streaming frames (`message_update` / `tool_execution_update`) are already absent (ADR 0009).

Example consumer:
```js
const es = new EventSource("http://127.0.0.1:19563/api/events");
es.addEventListener("snapshot", (e) => render(JSON.parse(e.data)));
es.addEventListener("log",      (e) => append(JSON.parse(e.data)));
```

## Action endpoints (POST)

Each shells the matching `pid <cmd> --json` and returns its `{ok,data|error}`. All are refused with **403** when the server runs `--read-only`.

| Endpoint | Body | Mirrors |
|-|-|-|
| `POST /api/services/:name/start` | — | `pid start <name>` |
| `POST /api/services/:name/stop` | — | `pid stop <name>` |
| `POST /api/services/:name/restart` | — | `pid restart <name>` |
| `POST /api/services/:name/enable` | — | `pid enable <name>` |
| `POST /api/services/:name/disable` | — | `pid disable <name>` |
| `POST /api/services/:name/quarantine` | — | `pid quarantine <name>` |
| `POST /api/services/:name/unquarantine` | — | `pid unquarantine <name>` |
| `POST /api/services/:name/resume` | `{ daily?, weekly?, dailyTokens?, unlimited?, reset? }` | `pid resume <name> [flags]` |
| `POST /api/budget/:name/reset` | — | `pid budget reset <name>` |
| `POST /api/approvals/:id/approve` | `{ value? }` | `pid approve <id> [--value]` |
| `POST /api/approvals/:id/deny` | `{ reason? }` | `pid deny <id> [--reason]` |
| `POST /api/reload` | — | `pid reload` |

Example:
```bash
curl -X POST http://127.0.0.1:19563/api/services/scraper/stop
curl -X POST http://127.0.0.1:19563/api/approvals/req_2/deny -d '{"reason":"nope"}'
```

## Security model

The example enforces a deliberate floor (ADR 0011 §4); hardening for public exposure (auth, TLS, :443) is the user's reverse proxy, not the example.

- **Bind 127.0.0.1 by default** (`--host` to change — at your own risk; pair with your own auth/TLS).
- **Host-header guard (always on):** requests whose `Host` is not the bound host/loopback are rejected (defeats DNS-rebinding, where a malicious page resolves its domain to `127.0.0.1` and POSTs to your port).
- **Origin guard (always on):** a request carrying an `Origin` that is neither same-origin nor in the allowlist is rejected **403**. The bundled UI is same-origin, so it always works; random web pages are blocked.
- **Embedding (cross-origin) is an explicit opt-in:** `--allow-origin <origin>` (repeatable) adds your own dashboard's origin to the allowlist; the server then emits `Access-Control-Allow-Origin: <origin>` for it, so a widget hosted there may `fetch`/`EventSource` the facade. This reconciles the anti-rebinding guard with legitimate Option-C embedding: known origins in, unknown origins out.
- **`--read-only`:** all POST endpoints return 403; reads and the stream remain available. (Default is actions-enabled — pi-congruent; see ADR 0011 §4.)

## Embedding (Option C)

Two ways to put pid data into an existing dashboard:
1. **Drop in the web component** — `<pid-services>` / `<pid-approvals>` (shipped in `examples/dashboard/`). Point it at a facade URL; it renders by consuming this API. Allow its host origin with `--allow-origin`.
2. **Roll your own** against this API (or, on-box, against `pid … --json` + the chronicle directly). Everything the bundled UI shows is available here — there are no private endpoints.
