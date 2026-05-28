# Extensions with pid

How pi's extension system and pid's supervision layer cooperate.

This document is for anyone who already knows what `pid` is (start with [the intro](../intro.md) if not) and wants to extend it. The short version is: **`pid` doesn't have its own extension API in v0 — instead, you write `pi` extensions, and `pid` supervises them transparently.** That sounds limiting until you see how the two layers compose. This document walks through that.

## The mental model

`pi` and `pid` are loosely coupled via pi's documented RPC protocol. Neither knows much about the other:

- **`pi` extensions live inside the `pi` subprocess**, not inside `pid`. They use pi's full extension API. They have no knowledge of `pid` and import nothing from it.
- **`pid` reads the event stream every `pi` subprocess emits** on stdout. It logs events, accumulates per-service state (cost, failure history, pending approvals), and writes responses back to stdin when needed.
- **The contract between them is pi's RPC event protocol** — events flowing out of `pi`, responses flowing in. That's the only coupling.

Picture it like this:

```
┌──────────────────────────────────────┐
│         pid daemon                   │
│   reads stdout events                │
│   writes stdin responses             │
└──────────────────────────────────────┘
        ▲ events           │ responses
        │ (JSONL)          ▼ (JSONL)
┌──────────────────────────────────────┐
│         pi --mode rpc                │
│   ┌──────────────────────────────┐   │
│   │   Your extension(s) live      │   │  ← extensions run in pi's process,
│   │   inside this pi process:     │   │     not pid's. They have full
│   │   • register tools            │   │     access to pi's API and to the
│   │   • subscribe to events       │   │     agent's session state.
│   │   • prompt the user           │   │
│   └──────────────────────────────┘   │
└──────────────────────────────────────┘
```

Two consequences worth internalising:

1. **You write a pi extension once, and it works the same whether you run pi interactively or under `pid`.** The extension code doesn't change; pi takes care of routing it correctly per context.
2. **Anything your extension does that surfaces in the event stream — register a tool, intercept a call, ask the user — becomes visible to `pid` automatically.** That's how the layers compose without any special API.

The three patterns below all rest on this.

## Pattern 1 — Add a custom tool to your supervised agent

The simplest pattern. You give the agent a new capability via a pi extension; `pid` supervises the result with zero code changes on the pid side.

**The extension** (`my-fetch-tool.ts`, lives in your service's extensions folder):

```ts
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";

export default function (pi: ExtensionAPI) {
  pi.registerTool({
    name: "fetch_url",
    label: "Fetch URL",
    description: "Fetch a URL and return its body as text",
    parameters: Type.Object({
      url: Type.String({ description: "URL to fetch" }),
    }),
    execute: async (_id, { url }) => {
      const res = await fetch(url);
      const text = await res.text();
      return { content: [{ type: "text", text }], details: {} };
    },
  });
}
```

**The service file** (`~/.pi/pid/services/news-summariser.yaml`):

```yaml
name: news-summariser
cwd: ~/projects/news
trigger:
  type: cron
  schedule: "0 8 * * *"
prompt: |
  Fetch https://hnrss.org/frontpage, pick the top 5 stories,
  summarise each in one sentence, write to ~/reports/$(date +%F).md
budget:
  daily_usd: 0.50
```

You place `my-fetch-tool.ts` in `~/projects/news/.pi/extensions/` so pi picks it up automatically when launched in that `cwd`. See pi's extension discovery rules in `extensions.md` (in pi's docs) for all the places pi looks.

**What `pid` sees** when the agent calls your custom tool:

```jsonl
{"type":"tool_execution_start","toolCallId":"call_1","toolName":"fetch_url","args":{"url":"https://hnrss.org/frontpage"}}
{"type":"tool_execution_end","toolCallId":"call_1","toolName":"fetch_url","result":{...},"isError":false}
```

`pid` doesn't know or care that `fetch_url` is custom. It logs the events, doesn't quarantine on success, and tracks any costs from the surrounding assistant messages. The agent has gained a new capability; `pid`'s policies still apply.

**Why this is useful**: anything you can build as a pi tool — HTTP calls, database queries, internal API wrappers, calls to your own services — your supervised agent can use, with `pid`'s safety net wrapped around it.

## Pattern 2 — Intercept tool calls with deterministic policy

You write a pi extension that hooks into the `tool_call` lifecycle. This runs *inside* the pi subprocess, so it can take instant decisions on tool calls before they execute, without a round-trip to `pid` or human approval.

**The extension** (`secret-scanner.ts`):

```ts
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

export default function (pi: ExtensionAPI) {
  // Block any bash command that contains what looks like an API key
  const secretPattern = /\b(sk-[a-zA-Z0-9]{20,}|AKIA[0-9A-Z]{16})\b/;

  pi.on("tool_call", async (event) => {
    if (event.toolName === "bash") {
      const cmd = event.input.command as string;
      if (secretPattern.test(cmd)) {
        return { block: true, reason: "Command contains a credential-like string" };
      }
    }
    return undefined;
  });
}
```

**What happens when the agent tries to do something dangerous:**

1. Agent emits a `bash` tool call: `echo $ANTHROPIC_API_KEY > /tmp/log.txt`.
2. Your extension's `tool_call` handler runs *inside the pi process*, recognises the pattern, returns `{ block: true, reason }`.
3. pi treats the tool call as blocked, sends an error result back into the agent's context (so the LLM knows it was blocked and can adapt), and emits a `tool_execution_end` event with `isError: true`.
4. `pid` reads that event from stdout, logs it, and feeds it into the crash-loop detector. If the agent keeps trying the same blocked thing, the failure signature accumulates and `pid` quarantines the service.

**The collaboration:**

- **The extension is the local fast-path.** No round-trip, decision is immediate, no human involved.
- **`pid` is the centralised audit and policy layer.** It logs every block, tracks how often it happens, can quarantine the service if the same block fires 50 times (suggesting the agent's stuck on a forbidden path), and can layer additional policy on top via `gate:`.

**When to use which**:

- **Programmatic rule with no ambiguity** ("never run any command containing this regex"): pi extension. Fast, deterministic, no human in the loop.
- **Rule that requires human judgment** ("ask me before deleting anything in production"): `pid`'s `gate:` field plus the approval inbox.

They compose cleanly because both surface their decisions in the event stream. A real-world layering:

```yaml
# pid gates anything destructive — sends to approval inbox
gate:
  - bash:rm
  - bash:git-push

# Meanwhile the secret-scanner extension auto-blocks credential-leaking
# commands without bothering you for approval. The two systems don't
# conflict: the extension's block fires first (in-process), and pid
# never sees the request because it was vetoed before execution.
```

## Pattern 3 — Ask the user something, route it through pid's approval inbox

This is the most architecturally interesting pattern. It's how pi's "ask the user" feature works transparently in both interactive and supervised contexts.

**Pi's built-in mechanism**: any extension can prompt the user:

```ts
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

export default function (pi: ExtensionAPI) {
  pi.registerCommand({
    name: "deploy",
    description: "Deploy current branch to production",
    handler: async (_args, ctx) => {
      const confirmed = await ctx.ui.confirm(
        "Deploy to production?",
        "This will affect live users.",
      );
      if (!confirmed) {
        ctx.ui.notify("Deployment cancelled", "info");
        return;
      }
      // ...actually deploy...
    },
  });
}
```

Pi handles `ctx.ui.confirm()` differently depending on the mode it's running in:

| pi mode | `ctx.ui.confirm()` becomes... |
|---|---|
| TUI (interactive) | A modal dialog in the terminal; user picks Yes/No |
| RPC (headless under `pid`) | An `extension_ui_request` event emitted on stdout |
| JSON / print | An error or default (no user available) |

**What `pid` does** when it sees `extension_ui_request` on stdout:

```jsonl
{"type":"extension_ui_request","id":"uuid-1","method":"confirm","title":"Deploy to production?","message":"This will affect live users."}
```

(The fields vary by method — `confirm` has `title` and `message`; `select` has `title` and `options`; `input` has `title` and optional `placeholder`; `notify` has `message` and `notifyType` and is fire-and-forget with no response needed.)

The supervisor:

1. Looks up the matching service config.
2. If `method === "notify"`: log it, don't enqueue. No response needed.
3. Runs policy: does this request match `auto_approve`? If yes, write the response back immediately. Does it match `gate`? If yes, enqueue. (Default: enqueue.)
4. If enqueueing: persist the request to `~/.pi/pid/approvals/<uuid-1>.json` and bump the service's `pending_approvals` counter.
5. Until someone runs `pid approve uuid-1` or `pid deny uuid-1`, the pi subprocess is **paused** on this prompt — its event loop resumes only when a matching `extension_ui_response` arrives on stdin. (If the request included a `timeout` field, pi auto-resolves with a default value when it expires.)
6. When you approve or deny via CLI, `pid` writes the matching response back:

```jsonl
{"type":"extension_ui_response","id":"uuid-1","confirmed":true}
```

(The response format matches the method: `confirmed: boolean` for `confirm`, `value: string` for `select`/`input`/`editor`, or `cancelled: true` for denial of any method.)

7. pi delivers `true` back to the extension's `await ctx.ui.confirm(...)`. **The extension code is exactly the same as the interactive case.** It doesn't know `pid` was involved.

**Why this matters**: you write an extension once, and it works in both contexts without modification. The author of the extension doesn't need to think about supervision; the operator running it under `pid` doesn't need to modify the extension. The contract is `extension_ui_request/response`, defined by pi, and respected by both sides.

A worked example from end to end:

1. You write the `deploy` extension above.
2. You drop it in your service's `.pi/extensions/`.
3. The agent runs your `deploy` command on a cron schedule.
4. At the `ctx.ui.confirm()` line, the subprocess pauses; `pid` puts the request in your inbox.
5. You get an alert (or check `pid approvals` later); see the question.
6. You run `pid approve uuid-1` — agent receives `true` and proceeds with deployment.
7. `pid` logs the entire transaction (the approval was logged with its decision, the deployment was logged via subsequent `tool_execution_*` events, the cost was tracked).

If you'd run the same extension via `pi` interactively, steps 4–6 would be a modal dialog in your terminal. Same code path, different surface.

### When to use this pattern (and when not to)

Approval requests are a powerful feature with one major failure mode: **fatigue**. If every other tool call generates an approval request, the operator either turns gating off entirely (effective YOLO) or starts approving without reading (theatrical safety). Both are worse than no gating at all, because they create an illusion of oversight that doesn't exist.

Design guidance:

- **Use approval requests for the half-dozen actions you genuinely don't want happening without a glance** — destructive bash, force-pushes, deploys, large spends. Not for routine reads or analyses.
- **Default everything else to `auto_approve:`** — file reads, greps, finds, listings, normal git inspection. The user shouldn't see these in the inbox.
- **If your gate list grows past a dozen patterns**, that's a signal that you're using approvals for risks that approvals aren't well-suited to (broad capability constraints). Wait for `pikg` (capability-scoped tool access), or for now, lean on process-level isolation (separate `cwd` per service, capability-restricted user accounts) rather than expanding gates.
- **Don't write extensions that prompt the user for routine decisions.** If your extension calls `ctx.ui.confirm()` on every iteration of a loop, you've designed a fatigue machine — refactor it so the decision happens once per session, not once per action.

The principle: gate sparingly, and design so the operator's attention is reserved for moments where it actually matters.

## Where each kind of rule belongs

Different layers of the stack are good at different things. A practical decision heuristic:

| Rule | Layer | Speed | Human? |
|---|---|---|---|
| Programmatic, no ambiguity | pi extension (in-process) | instant | no |
| Needs human judgment | `pid` `gate:` + approval inbox | seconds–minutes | yes |
| Policy about *how* the agent runs | `pid` service file | config-time | no |
| Fleet-level governance | `pid` daemon (event-aware) | real-time | no |

So:

- Want to block any tool call matching a regex? **pi extension.**
- Want to require approval before destructive actions? **`pid` `gate:` field.**
- Want to cap an agent at $5/day? **`pid` service file `budget:`.**
- Want to detect when an agent has crashed 5 times in a row? **`pid` daemon, built-in.**
- Want to give your agent access to your company's internal API? **pi extension (custom tool).**
- Want to log every tool call across all your agents to one place? **`pid` event consumer (built-in).**

When you're designing your own automation, the question becomes "where on this stack does each rule belong?" — not "do I write pi code or pid code?" — because they're complementary.

## What pid does *not* let you extend (yet)

For honesty, here's what you can't do today:

- **You can't write a `pid` plugin** in v0. The daemon has no plugin API; everything goes through service files and pi extensions. This is deliberate while the supervisor stabilises.
- **You can't add custom trigger types** beyond the built-in `manual`, `cron`, and `file_watch`. Webhooks land in v0.2.
- **You can't add custom approval delivery channels** beyond the CLI inbox. Slack, mobile push, and web dashboards are on the roadmap.
- **You can't add custom failure-signature derivation** beyond `pid`'s built-in rules. If you need more aggressive crash detection, your pi extension can emit synthetic failures into the stream.

If any of these are blocking you, that's a great signal — file an issue. The shape of the eventual `pid` plugin API will be informed by the first few use cases that hit those walls.

## Related reading

- [pi extensions documentation](https://github.com/earendil-works/pi-mono/blob/main/packages/coding-agent/docs/extensions.md) — pi's extension API in full
- [pi RPC protocol](https://github.com/earendil-works/pi-mono/blob/main/packages/coding-agent/docs/rpc.md) — every event and command pid relies on
- [pid v0 design spec](./v0-spec.md) — the daemon, control plane, and supervisor internals
- [Intro to pios](./intro.md) — broader context for what pid is part of

---

# Changelog

### 2026-05-28 00:17 BST — Integrity check against pi v0.76.0

One correction applied during cross-referencing against pi source at commit `1e168a89`:

1. **`extension_ui_request/response` section** (Pattern 3): Expanded to document method-specific field variations. The original showed a single event shape; the actual protocol has different fields per method (`confirm` has `title`+`message`; `select` has `title`+`options`; `input` has `title`+`placeholder`; `notify` is fire-and-forget with no response needed). Added response format variants (`confirmed: boolean` for confirm, `value: string` for select/input/editor, `cancelled: true` for denial). Added `notify` fire-and-forget handling and `timeout` auto-resolve behavior. Source: `packages/coding-agent/src/modes/rpc/rpc-types.ts` (`RpcExtensionUIRequest`, `RpcExtensionUIResponse` union types), `packages/coding-agent/docs/rpc.md` Extension UI Protocol section.

**Note:** The extension API examples (Patterns 1–3) were verified against pi's extension docs and source. `registerTool`, `pi.on("tool_call")`, `registerCommand`, `ctx.ui.confirm()`, `ctx.ui.notify()`, typebox usage, and `.pi/extensions/` discovery path all confirmed correct.
