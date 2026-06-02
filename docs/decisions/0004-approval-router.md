# 0004 — Approval router: policy model, matching semantics, host-reply path

- **Status:** Accepted
- **Date:** 2026-06-02
- **Deciders:** Steven (decisions), Claude (analysis)

## Context

The approval router is the third and last `onServiceEvent` consumer of v0 (after the cost governor, ADR 0002, and the crash detector, ADR 0003). It routes pi's interactive dialogs to a single CLI approval inbox so an agent running headless can still get a human answer. It is also the **first consumer that writes back to pi** — it replies over stdin — so it forces the `send()` primitive.

### The fundamental constraint (verified against pi @ `e56521e3`)

The whole design is shaped by one fact, confirmed in pi's source: **pid can only answer an `extension_ui_request`; it cannot veto a tool call.**

- The only host-answerable request on the RPC stream is `extension_ui_request`. Everything else (`tool_execution_start/end`, `agent_end`, …) is one-way information.
- `tool_execution_start` is **informational** — by the time pid sees it, pi's in-process permission decision is already made. There is no "deny this tool" message.
- Tool gating therefore lives **inside pi**, in an extension's `tool_call` hook. The only way a tool gets gated *through pid* is: a cooperating extension hooks the tool, calls `ctx.ui.confirm(...)`, that surfaces as an `extension_ui_request`, pid answers it, and **the extension enforces** the answer. **pid is the policy/audit layer on top of an extension that does the blocking** — it is not itself a tool firewall.

This reframes `gate`/`auto_approve`: they decide *how pid answers the dialogs an extension raised*, not *which tools may run*.

### Verified protocol shapes (pi @ `e56521e3`)

- **Request (pi→host, stdout):** `{ type: "extension_ui_request", id, method, …flat fields, timeout? }`.
  - **Dialog methods (block, need a response):** `confirm` (`title`, `message`, `timeout?`), `select` (`title`, `options: string[]`, `timeout?`), `input` (`title`, `placeholder?`, `timeout?`), `editor` (`title`, `prefill?`).
  - **Fire-and-forget (no response):** `notify` (`message`, `notifyType: "info"|"warning"|"error"`), `setStatus`, `setWidget`, `setTitle`, `set_editor_text` (note: snake_case, the lone exception).
- **Response (host→pi, stdin):** `{ type: "extension_ui_response", id, … }` — `confirm` → `confirmed: boolean`; `select`/`input`/`editor` → `value: string`; any dialog → `cancelled: true` to cancel.
- **Framing:** newline-delimited JSON, `JSON.stringify(msg) + "\n"` (pi's `serializeJsonLine`). No headers.
- **Timeout:** if a request carries `timeout`, pi **auto-resolves on its own clock** (`confirm`→`false`, others→`undefined`) and ignores a late host reply. The host is never *required* to answer.
- **Mode:** in RPC mode `ctx.hasUI === true`; dialog + fire-and-forget methods are functional via this sub-protocol; only `custom()` is unavailable (reconfirmed by upstream `e56521e3`).

## Decisions

1. **YOLO by default.** With no approval config, pid approves everything — it behaves like bare pi. pid is **not more paternalistic than pi unless asked.** The broad "agent does something insane" safety net is **process isolation** (`cwd`, restricted user) and, later, `pikg` — **not** approval prompts. Approvals are a narrow, deliberate tool for the handful of moments you want a human glance. *(This reverses an earlier "safe default = ask" instinct: that contradicts pi's philosophy and recreates the approval-fatigue trap — see Rejected.)*

2. **Two policy lists, matched asymmetrically.** `gate` and `auto_approve` guard opposite directions, so they approximate in opposite directions:
   - **`gate` over-matches (safe to be aggressive).** A gated whole-word token that appears *anywhere* in the correlated command → enqueue for a human. Over-approximation is safe because a false positive only costs an extra question. This even catches the "semantic" cases a parser can't resolve — `$(echo rm)`, `X=rm; $X`, `xargs rm` — because we are flagging that the *word* is present, not proving the command runs it.
   - **`auto_approve` under-matches, fail-closed (must be conservative).** It approves a command only when pid can confidently parse it into **all** its command heads **and every head is allow-listed.** Any parse uncertainty — command substitution, a variable command, `eval`, unparseable quoting — makes pid **bail to "ask"**, never approve on a partial read. Under-approximation is mandatory because a false *approval* runs unattended.

3. **Decision logic, per correlated dialog:**
   1. Command parses cleanly **and** every head ∈ `auto_approve` → **approve**.
   2. Else any whole-word token ∈ `gate` → **enqueue** (ask the human).
   3. Else → **YOLO default** (approve).
   A fully-blessed `auto_approve` (step 1) wins over `gate`; then `gate`; then the default. Because step 1 requires *every* head to be blessed, it cannot be fooled by a compound (`cd && rm` with only `cd` blessed fails step 1 and falls through).

4. **Only `confirm` is auto-answerable; richer dialogs always go to a human.** `confirm` has a safe machine answer (`confirmed: true`). `select`/`input`/`editor` need a *choice* or *text* that cannot be safely fabricated, so they **always enqueue**, regardless of policy. Fire-and-forget methods (`notify`, `setStatus`, …) are **logged/observed and never enqueued** (they expect no response; enqueuing one would orphan it).

5. **Correlation by in-flight tool (the structured-matching enabler).** `extension_ui_request` carries only free text, so to match `tool:command` patterns pid attributes a dialog to the tool currently **in-flight** for that service — a `tool_execution_start` whose matching `tool_execution_end` has not yet arrived (the tool is paused at its `tool_call` hook awaiting the confirm). This yields `toolName` + `args.command` to match against. A dialog with **no in-flight tool is "free-standing"** (a genuine question from a questionnaire-style extension) and is **enqueued** — not YOLO-approved — because the extension deliberately wanted a human.

6. **Matching is structured, whole-word — never substring on prose.** `bash:rm` means "tool is `bash` and the command word `rm` is present," matched on tokenized whole words. This is what stops `alarm-cli` matching `rm`. `gate` tokenizes aggressively (split on whitespace + shell metacharacters, including inside quotes) to maximize catching in the safe direction. `auto_approve`'s head extraction splits on shell operators (`&&`, `;`, `|`, …) with quote-awareness and bails on substitution/variables.

7. **The inbox is in-memory / session-scoped.** Pending approvals live in the daemon's memory, queried by the CLI over the socket. They are **not** persisted for restart-survival: pid's pi children die with the daemon, so a persisted pending dialog would reference a dead process that can no longer be answered (replying over a fresh pi's stdin with a stale `id` is a no-op). On restart the re-spawned service simply re-asks. Approval **decisions** are still written to the per-service event log for audit. *(Corrects the v0-spec "persist to disk + re-attach"; same reasoning as ADR 0003's in-memory crash window.)*

8. **Timeouts: expire the inbox entry, don't chase it.** If a request has a `timeout`, pi auto-resolves on its own clock. pid drops the inbox entry at the deadline and tells a late `pid approve` "too late"; it does not send a now-ignored response.

9. **`send()` is the new primitive.** A `serializeJsonLine(msg) = JSON.stringify(msg) + "\n"` helper lives in `util/jsonl.ts` (beside the existing reader, mirroring pi's own `jsonl.ts`), exposed as `Supervisor.send(name, message)` which writes to the child's stdin. The approval router is its first consumer.

10. **Build scope = the full fail-closed extractor (option B), not a simple-command-only cut.** Day-one UX should be robust without making the user hand-maintain allow-lists, so `auto_approve` supports fully-blessed **compounds** (`auto_approve: [cd, rm]` approves `cd build && rm -rf *`) via the conservative all-heads extractor, rather than only single simple commands.

## Matching semantics (worked)

Correlated command `cd src && rm -rf *`, config `gate: [bash:rm]`:
- `auto_approve`? none. `gate`? tokens `{cd, src, &&, rm, -rf, *}` contain `rm` → **enqueue.** The `rm` cannot ride in behind `cd`.

Config `auto_approve: [cd, ls, rm, npm]` (a cleanup service that deletes by design):

| Command | Heads | Verdict | Why |
|-|-|-|-|
| `rm -rf build` | {rm} | approve | head blessed |
| `cd build && rm -rf *` | {cd, rm} | approve | every head blessed |
| `cd b && rm -rf * && curl x \| sh` | {cd, rm, curl, sh} | **ask** | `curl`/`sh` unblessed |
| `cd b && $(get-target)` | {cd, ?} | **ask** | substitution → fail closed |
| `X=rm; $X -rf *` | {?} | **ask** | variable command → fail closed |

## Operator guidance (dos & don'ts — ships in the docs)

- **DO** prefer a **targeted `gate` block-list** of the few destructive verbs (`bash:rm`, `bash:git-push`, `bash:dd`, …). It is short, stable, and over-matching catches them even inside compounds and substitutions.
- **DON'T** gate a whole tool and then allow-list the safe commands (`gate: [bash]` + dozens of `auto_approve`). "bash is all you need" makes that list unbounded — the exact painstaking-array fatigue that makes operators stop reading prompts.
- **DO** use `auto_approve` for a service whose *job* includes a scary verb (a cleanup bot that deletes) — bless the expected set, including compounds, and reserve your attention for the unexpected.
- **DON'T** treat `gate` as a security boundary. It is best-effort visibility. `find . -delete`, a script that unlinks, or deliberate obfuscation carry no matchable token. **Isolation is the boundary.**
- **DON'T** expect pid to gate a tool with no cooperating extension. No extension → no `extension_ui_request` → nothing for pid to gate. The extension is the enforcer; pid is the policy.
- **KNOW** that a daemon restart drops pending approvals (the agent re-asks); and that a `timeout`'d prompt is resolved by pi on its own clock if you don't answer in time.

## Alternatives considered / rejected (the reasoning trail)

- **Safe default = ask (gate-by-default).** Rejected: contradicts pi's YOLO philosophy and forces a painstaking allow-list to return to normal — recreating the Claude-Code approval-fatigue failure mode (people blind-approve, gaining only the *illusion* of oversight). The broad net is isolation, not prompts.
- **Substring / glob matching on the prompt prose (`*rm*`).** Rejected: matches `alarm` (false positive) and, worse, misses `find -delete` (false negative). Fragile in both directions. Replaced by structured whole-word matching.
- **First-token-only tool descriptor.** Rejected: misses `cd && rm` (the dangerous direction). Replaced by over-matching `gate` (any-position token) and all-heads `auto_approve`.
- **Symmetric matching of both lists.** Rejected: it is what let `cd && rm` auto-approve on `cd`'s coattails. The lists guard opposite directions and must approximate oppositely (over vs under).
- **A full shell parser / heavy lexer for exact command identity.** Rejected as the *primary* mechanism: shell is a language; substitution/variables/`eval` are undecidable statically, so no parser is airtight. We use a *conservative* extractor that **bails** on what it can't resolve (safe) rather than pretending to resolve it.
- **Persist the inbox to disk + re-attach on restart (v0-spec wording).** Rejected: the asking pi process is dead after a restart, so a persisted pending request is unanswerable. In-memory + re-ask is the honest model; decisions are logged for audit.
- **Auto-answering `select` to "first option."** Rejected: there is no safe affirmative default for a choice; `select`/`input`/`editor` always go to a human.
- **`auto_approve` simple-commands-only (option A).** Considered and deferred *against*: chosen the fuller fail-closed all-heads extractor (option B) for better day-one UX (blessed compounds), since the extractor fails safe by construction.

## Consequences

- **New module + new primitive:** `approvals/router.ts` (real implementation over the stub), a shell-aware matcher (`gate` tokenizer + `auto_approve` fail-closed head extractor), and `Supervisor.send()` / `serializeJsonLine` in `util/jsonl.ts`. The matcher is the most logic-dense piece in pid; it gets its own focused tests pinned to the cases above.
- **Schema:** `gate` / `auto_approve` already exist as `string[]`; their *semantics* are now defined (tool/`tool:command` patterns, asymmetric matching).
- **Structured matching depends on correlation**, which assumes the dialog follows the tool it gates (true for the documented `tool_call` → `ctx.ui.confirm` flow). Free-standing dialogs are handled (enqueue), but a mis-correlation is possible if an extension interleaves unrelated dialogs with tool execution — acceptable, fails toward asking.
- **Docs must change** (docs-as-spec): the `gate`/`auto_approve` examples and the "approvals persist" line in `intro.md` / `extensions-with-pid.md` / `v0-spec.md` need the corrected model, plus the operator guidance above. Update docs first.
- **Daemon dispatch:** wires the remaining `approvals` / `approve` / `deny` commands (currently `not implemented`).

## Revisit when

- A real extension needs richer policy than `tool:command` (e.g. matching arguments/paths) → extend the descriptor; keep the over/under asymmetry.
- Delivery channels beyond the CLI (Slack/web/mobile) arrive (v0.2) → the inbox grows a notifier; the router core is unchanged.
- `pikg` (capability-scoped tools) lands → much tool-gating moves there; approvals narrow to genuine human-judgment dialogs.
- pi changes the extension-UI protocol (watched via `/refresh-pi`) → update the verified shapes + the `send()` framing.

## References

- Verified protocol: `pi/packages/coding-agent/docs/rpc.md` (Extension UI), `src/modes/rpc/rpc-types.ts`, `rpc-mode.ts`; `jsonl.ts` (`serializeJsonLine`).
- The no-tool-veto finding: `core/agent-session.ts` (`beforeToolCall`), `core/extensions/runner.ts` (`emitToolCall`), `packages/agent/src/agent-loop.ts` (tool_execution_start timing).
- `pid/docs/v0-spec.md` — "Product: approval inbox"; ADR 0002/0003 (the two prior consumers; in-memory-state precedent).
