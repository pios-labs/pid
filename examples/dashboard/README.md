# pid dashboard (example)

A build-free, vanilla **mission-control dashboard** for a running `pid` daemon — and, more importantly, the **HTTP/SSE facade** it's built on, which any browser, remote dashboard, or embedded widget can consume.

This is a *reference you fork*, not a shipped product. It has **no features of its own**: it is purely a consumer of what `pid` already exposes.

## Run it

```bash
# from anywhere `pid` is on your PATH, with the daemon running:
node server.mjs                 # serves http://127.0.0.1:7878
# then open http://127.0.0.1:7878 in a browser
```

Flags:

| Flag | Default | Meaning |
|-|-|-|
| `--port <n>` | `7878` | listen port |
| `--host <addr>` | `127.0.0.1` | bind address (changing it is at your own risk — pair with your own auth/TLS) |
| `--read-only` | off | disable all actions (POSTs return 403); the UI hides its controls |
| `--allow-origin <origin>` | — | allow a cross-origin embedder (repeatable) — see Embedding |
| `--pid-bin <path>` | `pid` (or `$PID_BIN`) | the `pid` CLI to shell |
| `--poll-ms <n>` | `1500` | snapshot poll interval |

## How it works

The server is a **pure CLI consumer** (ADR 0011 §2): it gets all data and performs all actions by shelling the documented `pid` CLI — `pid tail --raw` for the live event stream, `pid … --json` for snapshots and actions. It imports nothing from pid's internals, so the whole thing is reimplementable in any language by shelling the same commands.

It exposes that over HTTP as a small, documented API — **`docs/dashboard-api.md`** is the contract:

- `GET /api/events` — one SSE stream carrying `snapshot` (current services / approvals / budgets, pushed ~every 1.5s and on connect) and `log` (one chronicle envelope per live event).
- `GET /api/services`, `/api/approvals`, `/api/budget/:name`, `/api/version` — point reads.
- `POST /api/services/:name/{start,stop,restart,…}`, `/api/approvals/:id/{approve,deny}`, `/api/reload`, … — actions.

The bundled `index.html` is just the first client of that API.

## Security

The example enforces a deliberate floor (ADR 0011 §4); production hardening (auth, TLS, `:443`) is your reverse proxy, not this example.

- Binds **127.0.0.1** by default.
- **Host- and Origin-header guards** are always on (defeat DNS-rebinding and localhost-CSRF).
- **Actions are enabled by default** (pi-congruent: pi trusts the local operator). Use `--read-only` to make it a pure viewer.

## Embedding in another dashboard (Option C)

Point your own page at this facade and allow its origin:

```bash
node server.mjs --allow-origin https://my-dashboard.example
```

Then `fetch`/`EventSource` the API from that origin. Everything the bundled UI shows is available — there are no private endpoints. See `docs/dashboard-api.md`.
