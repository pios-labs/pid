# 0011 — The example dashboard: API-first facade, pure-CLI consumer, embeddable

- **Status:** Accepted
- **Date:** 2026-06-07
- **Deciders:** Steven (decisions), Claude (analysis)

## Context

Increment 3 of the observability mandate (workspace `CLAUDE.md`; memory `observability-mandate`) — the last pre-go-live piece. ADR 0008 D4 scoped a *lean, read-only* example dashboard. In design conversation (2026-06-07) Steven deliberately **expanded the goalposts**: the example should be the "kitchen-sink" of the read/control path — the `kitchen-sink.yaml` of dashboards — exposing *every operational command* and staying genuinely useful and forkable, while pid itself exposes all its data natively so anyone can build or integrate their own. This ADR supersedes ADR 0008 D4's "lean read-only viewer" framing (the rest of 0008 — daemon-free reads, no index, rotation — still stands) and records the architecture across the forks we worked two-lens.

Three integration paths must all work from the **same data our own dashboard uses**:
1. fork the example UI and restyle it;
2. build a dashboard from scratch against pid's exposed data;
3. **embed** pid data as a widget/card in an *existing* pi dashboard (Steven's "Option C") — a user who already runs a pi dashboard should add pid's services/cost/approvals to it, not run a second app.

### Cross-reference: BlackBelt `pi-agent-dashboard` (the popular pi dashboard, read-only review)

- It is a **full product** — React + Tailwind + Vite, a Fastify server with **dual WebSocket gateways**, Electron, a 5-package monorepo, xterm.js terminal, diff viewer. We are explicitly **not** rebuilding this (spaceship aversion).
- Its data comes from a **bridge extension injected into each pi process** → WS → an **in-memory store** → broadcast to all browser clients. It coexists with pi's terminal, doesn't replace it.
- It already has **two sanctioned third-party injection points**: a declarative *"UI modules as data"* system (extensions declare `table`/`grid`/`form` views as descriptors, no React/SDK), and a 10-slot React plugin system — *"the plugin architecture allows supervised or external-data overlays to claim UI slots without forking."*

Two lessons: (a) **expose data declaratively so a renderer needs no SDK** — congruent with "the example has no built-in features, it purely uses what pid exposes"; (b) **we get a head start for free** — BlackBelt needs a bridge in every pi process to harvest events; **pid already owns those processes and captures their streams into the chronicle**, so pid serves the same live data with no bridge to install.

## Decision

### 1. API-first: the deliverable is the contract; the UI is its first client.

The example is structured as a thin, **documented HTTP+SSE+POST facade** over pid's existing public contract, with the UI as a pure client of that facade. This single shape delivers all three integration paths: fork the UI (it's just a client), build from scratch (consume the facade, or the raw contract), embed (point a widget at the facade). The facade's HTTP/SSE surface is itself a documented contract — see `docs/dashboard-api.md` — a sibling tier to the on-box CLI/files contract: **on-box consumers** use `pid … --json` + the chronicle files; **over-HTTP consumers** (a browser, a remote dashboard) use the facade.

*Rejected — a monolithic server-renders-HTML app:* it makes the data reachable only through our UI; embedding (Option C) and from-scratch builds would have to scrape or reimplement. API-first is what makes "the same data our dashboard uses" literally true for everyone.

### 2. The facade is a pure CLI consumer — it shells `pid`, never imports `src/`.

The facade obtains **all** data and performs **all** actions by invoking the documented CLI: `pid tail --raw` for the live event stream, `pid list/status/approvals/budget … --json` for snapshots, `pid <cmd> --json` for actions. **No imports from pid's `src/` internals.** Consequences: (a) it is the strongest possible proof the CLI surface is complete — if the dashboard needs something the CLI can't give, that's a CLI gap to fix, not a dashboard shortcut; (b) it is trivially reimplementable in any language by shelling the same commands (the portability promise — our demo on a random port, or the user's server on :443); (c) it honours "no built-in features — purely uses what pid exposes."

*Mirror/lesson from BlackBelt:* keep an **in-memory current-state store**, refresh it, broadcast to N SSE clients — but fed by the CLI, not an injected bridge (which pid doesn't need).

### 3. Data model: two primitives — stream + snapshot — plus POST actions.

- **Stream:** `pid tail --raw` (all-service live chronicle) → parsed → fanned out to every SSE client as `log` events. O(new bytes).
- **Snapshot (poll-and-push):** the server polls `pid list --json`, `pid approvals --json`, and `pid budget show --json` (per budgeted service) on a short interval (~1–2 s) and pushes `snapshot` events over the same SSE channel. This is what makes the dashboard a **monitor**, not just a control panel: a crash-quarantine, an auto budget-pause, or a new approval appears on its own. (Current run-state, the live inbox, and budget headroom are *not* in the chronicle — they live in the daemon — so a poll is required; reconstructing them from the event stream was rejected as fragile.)
- **Actions:** browser `POST` → server shells `pid <cmd> --json` → returns the `{ok,data|error}` result.

Budget rides the uniform `--json` path because `budget show`/`reset` were wired as the prerequisite to this increment (proven engine, ADR 0002; daemon dispatch completed 2026-06-07). The data model therefore has **no exceptions**: stream the chronicle, snapshot via `pid … --json`, act via `pid … --json`.

### 4. Security posture: actions on by default; `--read-only` opt-in; localhost+origin floor always.

pi's actual permission philosophy is **trust the local operator** — *"Pi runs with all permissions by default"* (`containerization.md`); pid's own default is `on_unmatched: approve`. So the pi-congruent default is **actions enabled**, with restriction as the opt-in: **`--read-only`** makes the dashboard a pure viewer. The new risk is not the operator but the **network surface** (pid's first listening port; the daemon is a `0600` unix socket, "no network exposure"). That is handled by an always-on **floor**: bind **127.0.0.1** only, and an **Origin/Host guard** on the actions path (defeating DNS-rebinding / localhost-CSRF, where a malicious web page POSTs to `127.0.0.1:<port>`). Public exposure (:443) is the user's reverse proxy doing auth + TLS — explicitly out of scope for the example.

*Rejected — read-only by default + `--allow-actions`:* contradicts pid's own `on_unmatched: approve`; makes you opt into using your own tool. The honest counter-position (a port is where one might deliberately break from YOLO) was weighed and declined in favour of congruence + the origin-guard floor.

### 5. Launcher: a minimal, first-class `pid dashboard`; genericity comes from the API.

`pid dashboard` boots the bundled facade + serves the static UI, with `--port` / `--host` / `--read-only`. It is a thin spawn (logic lives in `examples/dashboard/`, not `src/`). "Not restricted to our example" is satisfied by the **documented API**, not by launcher flags: a user's own dashboard is any program that reads the facade (or the raw contract) and they run it however they like. The earlier `--exec`/dir-convention ideas were dropped as launcher gymnastics that the API makes unnecessary.

### 6. Ship a minimal embeddable web component **and** document the API.

A small self-contained custom element (e.g. `<pid-services>` / `<pid-approvals>`) that renders by calling the facade — droppable into an existing dashboard (Option C), including being wired into a BlackBelt-style UI-module/plugin slot by a thin adapter. The documented API lets anyone roll their own instead.

### 7. Layout: mission-control grid (bundled UI).

A single-screen ops board: a top strip of per-service status cards (state / cost / pending / `orphaned` / `config-changed` chips), a large unified live timeline below (all services, color-coded), and a right rail for the approval inbox + alerts (pauses / quarantines). It matches the "watch many unattended agents" job, and the service card is exactly the `<pid-services>` web component, so the widget is an extract, not extra work. Build-free: one hand-crafted dark-themed HTML/CSS/JS page, vanilla, no framework/bundler.

## Scope / deferral

- **Build-free, zero/one-dep, separate process.** The facade uses Node built-ins (`http` + child_process + the SSE pattern); no framework, no bundler. It is never the daemon (ADR 0008 D1 stands).
- **Auth / TLS / multi-user:** out of scope — the user's reverse proxy. The example ships the localhost+origin floor only.
- **No daemon changes.** Everything is over the existing CLI + chronicle contract.
- **gzip of aged archives, manual CLI-action logging:** still deferred (pre-go-live follow-ups), unchanged by this ADR.
- **Richer widgets / a full component library:** one or two minimal web components ship; more is fast-follow enabled by the API.

## Consequences

- **New `examples/dashboard/`** (not `src/` — it's the optional extra): a build-free facade server, the static mission-control UI, and a minimal embeddable web component. A reference users fork, not a shipped product.
- **A new first-class `pid dashboard` launcher** in core — a thin spawn of the bundled server with `--port`/`--host`/`--read-only`.
- **A new documented public contract** — `docs/dashboard-api.md` (the facade's HTTP/SSE surface), a sibling to the chronicle schema; referenced from `v0-spec.md` and the workspace doc map.
- **`budget show`/`reset` wired** (the prerequisite; done) so the data model is uniform.
- The facade being a pure CLI consumer means the **CLI is the integration contract** — any future "the dashboard needs X" is first a question of "should the CLI expose X."

## Revisit when

- A real need for cross-host facade discovery / multi-instance aggregation appears → consider a small registry; today one facade fronts one pid.
- Users want auth baked into the example (not just their proxy) → reconsider, carefully (it stops being "just a reader").
- pi or the ecosystem standardises a dashboard plugin contract → ship an adapter mirroring it (the web component + API already make this cheap).
- The poll-and-push interval proves too coarse/expensive at scale → consider a push from the daemon (the rejected ADR 0008 D1 option) — only if genuinely needed.
