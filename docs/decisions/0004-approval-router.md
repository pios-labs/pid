# 0004 — Approval router: policy model, matching semantics, host-reply path

- **Status:** Accepted
- **Date:** 2026-06-02 (matching model & grammar revised 2026-06-03 — see "Revision" below)
- **Deciders:** Steven (decisions), Claude (analysis)

> **Revision (2026-06-03).** Before increment B, a grilling pass found (a) the descriptor grammar was self-contradictory across the two lists, and (b) a deeper UX gap: under a *fixed* YOLO default, the **cautious** operator (small allow-list, ask about the rest) could not be served without exhaustively block-listing every danger. The fix adds a per-service **`on_unmatched: approve|ask`** posture knob and lifts `auto_approve` matching from command-*head* level to **subcommand/phrase** level (so `npm test` ≠ `npm publish`). The narrative of how we got here — including a "defer `auto_approve`" detour that was raised and **rejected** — is in `0004-grammar-and-postures-reply.md`. Decisions 1–3, 6, 10, the worked table, and the guidance below reflect the revision.

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

1. **Two first-class postures, set by `on_unmatched: approve|ask` (default `approve`).** There are exactly two legitimate operator intents, and the design must serve **both with a *small* list** — never forcing anyone to enumerate the complement:
   - **Trusting** (`on_unmatched: approve`, the default): "run freely, but stop for the dangerous few" → a small **`gate`** block-list. With no config at all this is pure YOLO — pid behaves like bare pi, **not more paternalistic than pi unless asked.**
   - **Cautious** (`on_unmatched: ask`): "only do these few things; ask me about everything else" → a small **`auto_approve`** allow-list.
   The two bad UXes we explicitly reject — *"approve 65 commands because I can't just block `rm`"* (forced allow-listing) and *"gate 25 args just to be safe"* (forced block-listing) — are exactly what happens if an operator is forced to use the wrong-sided list for their intent. The posture knob is what lets each intent stay small. The broad "agent does something insane" net remains **process isolation** + later `pikg`, never the prompt list.

2. **The two lists are matched asymmetrically — both biased toward "ask" (the safe direction):**
   - **`gate` over-matches** (false positive = one extra question, harmless): a gated phrase that appears as consecutive whole-word tokens *anywhere* in the correlated command → enqueue. This catches even the semantic cases a parser can't resolve — `$(echo rm)`, `X=rm; $X`, `xargs rm` — because it flags that the *word* is present, not that the command provably runs it.
   - **`auto_approve` under-matches, fail-closed** (false approval = unattended damage): a command auto-approves **only when it parses cleanly *and* every `&&`/`;`/`|` segment's leading words prefix-match a blessed phrase.** Substitution / `$VAR` / `eval` / unparseable quoting → **bail to "ask".** Matching is at **subcommand/phrase level**, not head level: `auto_approve: [bash:npm test]` blesses `npm test --watch` but **not** `npm publish` — the precision a cautious operator needs (head-level would auto-approve `npm publish` once `npm` is trusted, a real hole). A one-word phrase (`bash:npm`) still means "all `npm`", so phrase-level strictly generalises head-level. Because *every* segment must match, a compound can't be fooled (`cd && rm` with only `cd` blessed fails and falls through).

3. **Decision logic, per correlated dialog:**
   1. `auto_approve` fires (clean parse **and** every segment prefix-blessed, or a bare `<tool>` entry matches the dialog's tool) → **approve**.
   2. Else `gate` matches (a blessed phrase appears anywhere, or a bare `<tool>` entry matches the tool) → **enqueue**.
   3. Else → **`on_unmatched`** (`approve` = YOLO, or `ask`).
   `auto_approve` (under-match) wins over `gate` (over-match); then the posture default. In the two clean postures only one list is populated, so precedence is moot; it matters only in the advanced mixed "deny-default-for-bash with carve-outs" config (`on_unmatched: approve` + `gate: [bash]` + `auto_approve: [...]`).

4. **Only `confirm` is auto-answerable; richer dialogs always go to a human.** `confirm` has a safe machine answer (`confirmed: true`). `select`/`input`/`editor` need a *choice* or *text* that cannot be safely fabricated, so they **always enqueue**, regardless of policy. Fire-and-forget methods (`notify`, `setStatus`, …) are **logged/observed and never enqueued** (they expect no response; enqueuing one would orphan it).

5. **Correlation by in-flight tool (the structured-matching enabler).** `extension_ui_request` carries only free text, so to match `tool:command` patterns pid attributes a dialog to the tool currently **in-flight** for that service — a `tool_execution_start` whose matching `tool_execution_end` has not yet arrived (the tool is paused at its `tool_call` hook awaiting the confirm). This yields `toolName` + `args.command` to match against. A dialog with **no in-flight tool is "free-standing"** (a genuine question from a questionnaire-style extension) and is **enqueued** — not YOLO-approved — because the extension deliberately wanted a human.

6. **One descriptor grammar, both lists: `<tool>` or `bash:<phrase>`.** (Resolves the original inconsistency — `gate` used `tool:word`/bare-tool while the `auto_approve` table used bare command-heads.)
   - **`<tool>`** — an exact pi tool name (`bash`, `read`, `write`, `edit`, `grep`, `find`, `ls`). Tool-level: matches when the correlated `toolName` equals it. **A bare token is *always* a tool name, never a command word** — so `gate: [rm]` means "the (nonexistent) tool `rm`" and never matches; to act on the `rm` *command* you write `bash:rm`.
   - **`bash:<phrase>`** — the bash tool **and** `<phrase>`, one or more **space-separated** words, matched on whole tokens (so `alarm-cli` never matches `rm`). Multi-word phrases are subcommands: **`bash:git push`** (space) matches the consecutive tokens `git push`; `bash:git-push` (hyphen) would look for a literal `git-push` token and is wrong — the docs' hyphenated examples must become spaces. Hyphens stay literal, so `bash:docker-compose` correctly matches the single token `docker-compose`. The `:` form is **bash-only in v0** — bash is the only tool whose argument is itself a command language; non-bash arg-matching (e.g. `write:/etc/*`) is a deliberate wing, deferred.
   - `gate` matches the phrase as consecutive tokens *anywhere* (over); `auto_approve` requires every command segment's *leading* words to prefix-match a blessed phrase (under). Same grammar, opposite bias.

7. **The inbox is in-memory / session-scoped.** Pending approvals live in the daemon's memory, queried by the CLI over the socket. They are **not** persisted for restart-survival: pid's pi children die with the daemon, so a persisted pending dialog would reference a dead process that can no longer be answered (replying over a fresh pi's stdin with a stale `id` is a no-op). On restart the re-spawned service simply re-asks. Approval **decisions** are still written to the per-service event log for audit. *(Corrects the v0-spec "persist to disk + re-attach"; same reasoning as ADR 0003's in-memory crash window.)*

8. **Timeouts: expire the inbox entry, don't chase it.** If a request has a `timeout`, pi auto-resolves on its own clock. pid drops the inbox entry at the deadline and tells a late `pid approve` "too late"; it does not send a now-ignored response.

9. **`send()` is the new primitive.** A `serializeJsonLine(msg) = JSON.stringify(msg) + "\n"` helper lives in `util/jsonl.ts` (beside the existing reader, mirroring pi's own `jsonl.ts`), exposed as `Supervisor.send(name, message)` which writes to the child's stdin. The approval router is its first consumer.

10. **Build scope = the full fail-closed phrase extractor (option B), not a simple-command-only cut.** Day-one UX must serve the cautious posture properly, so `auto_approve` supports fully-blessed **compounds** (`auto_approve: [bash:cd, bash:rm]` approves `cd build && rm -rf *`) and **subcommand precision** (`bash:npm test` ≠ `npm publish`) via the conservative segment/phrase extractor that fails closed on what it can't parse. Deferring `auto_approve` was considered and **rejected** — it would force the cautious operator into exhaustive block-listing (the "gate 25 args" failure); see Rejected and the reply note.

11. **Audit goes into the single per-service chronicle (`logs/<name>.jsonl`), as documented `pid_approval` events — both the routing and the resolution.** The router writes a `pid_approval` line when a dialog is **enqueued** *and* when it is **resolved** (`auto_approve` / `approve` / `deny` / `expired`), so the trail shows a request's full life, not just its terminal state. They go into the existing per-service event log (not a separate file), interleaved with pi's raw stream and the existing `pid_parse_error` synthetic events — one ordered, replayable timeline, which is the ideal source for the mandated dashboard/index (see Revisit). Mechanically: a `logApproval(name, entry)` action on the Supervisor (mirroring `CrashActions.quarantine`) writes to the `RunningProcess.log` stream it already owns; it **no-ops if the service isn't running** (a late `deny`/timeout after the child exited — the reply would fail anyway). Rejected: a separate `logs/<name>.approvals.jsonl` (fragments the timeline the dashboard wants, and optimizes for a history query v0 doesn't have — wing test); in-memory-only (loses the audit trail the `soc2-evidence` use-case sells). **The `pid_approval` schema is a documented public contract** (per the observability mandate) — its fields are specified in `v0-spec.md`. This establishes the convention for `pid_*` intervention events generally (`pid_quarantine`, `pid_budget_pause` to follow on the other consumers).

## Matching semantics (worked)

**Trusting posture** — `on_unmatched: approve` (default), `gate: [bash:rm]`. "Just block `rm`":

| Command | Verdict | Why |
|-|-|-|
| `ls -la` | approve | no `gate` match → `on_unmatched: approve` |
| `rm -rf build` | **enqueue** | token `rm` present |
| `cd src && rm -rf *` | **enqueue** | over-match: `rm` present anywhere — can't ride in behind `cd` |
| `cd src && ls` | approve | no `rm` → `on_unmatched: approve` (no list to maintain) |

**Cautious posture** — `on_unmatched: ask`, `auto_approve: [bash:npm test, bash:git status, bash:ls]`. "Only these; ask about the rest":

| Command | Verdict | Why |
|-|-|-|
| `npm test --watch` | approve | segment leading words prefix-match `npm test` |
| `npm publish` | **enqueue** | `npm publish` ≠ blessed `npm test` → `on_unmatched: ask` |
| `npm test && git status` | approve | every segment prefix-blessed |
| `npm test && rm -rf /` | **enqueue** | second segment unblessed → fail (not all segments) |
| `ls \| $(get-target)` | **enqueue** | substitution → fail closed |

Both postures keep the operator's list small and never force enumerating the opposite side.

## Operator guidance (dos & don'ts — ships in the docs)

- **DO match the posture to your trust + scope.** Trust the agent / broad scope → **trusting** (`on_unmatched: approve` + a short `gate` block-list of the dangerous verbs). Don't fully trust it / narrow scope → **cautious** (`on_unmatched: ask` + a short `auto_approve` allow-list of what it's *for*). Each lists only its small side.
- **DON'T use the wrong-sided list for your intent.** Block-listing under a cautious intent means enumerating every danger ("gate 25 args just to be safe"); allow-listing under a trusting intent means enumerating every safe command ("approve 65 commands to block one `rm`"). If your list is growing unbounded, you've picked the wrong posture — or, more often, your service is mis-scoped: a *broad* agent you *don't* trust. Narrow it (one service / one `cwd` per task), don't grow the list.
- **DO** use subcommand precision in the cautious allow-list (`bash:npm test`, not `bash:npm`) so a blessed tool can't smuggle a dangerous subcommand (`npm publish`).
- **DON'T** treat `gate` as a security boundary. It is best-effort visibility — `find . -delete`, a script that unlinks, or deliberate obfuscation carry no matchable token. **Isolation is the boundary.** (Note the asymmetry: the *cautious* posture fails **closed** on anything it can't parse, so it is genuinely stronger than trusting-mode block-listing — which is best-effort against obfuscation.)
- **DON'T** expect pid to gate a tool with no cooperating extension. No extension → no `extension_ui_request` → nothing for pid to act on. The extension is the enforcer; pid is the policy.
- **KNOW** that a daemon restart drops pending approvals (the agent re-asks); and that a `timeout`'d prompt is resolved by pi on its own clock if you don't answer in time.

## Alternatives considered / rejected (the reasoning trail)

- **Safe default = ask (gate-by-default).** Rejected: contradicts pi's YOLO philosophy and forces a painstaking allow-list to return to normal — recreating the Claude-Code approval-fatigue failure mode (people blind-approve, gaining only the *illusion* of oversight). The broad net is isolation, not prompts.
- **Substring / glob matching on the prompt prose (`*rm*`).** Rejected: matches `alarm` (false positive) and, worse, misses `find -delete` (false negative). Fragile in both directions. Replaced by structured whole-word matching.
- **First-token-only tool descriptor.** Rejected: misses `cd && rm` (the dangerous direction). Replaced by over-matching `gate` (any-position token) and all-segments `auto_approve`.
- **Symmetric matching of both lists.** Rejected: it is what let `cd && rm` auto-approve on `cd`'s coattails. The lists guard opposite directions and must approximate oppositely (over vs under).
- **A full shell parser / heavy lexer for exact command identity.** Rejected as the *primary* mechanism: shell is a language; substitution/variables/`eval` are undecidable statically, so no parser is airtight. We use a *conservative* extractor that **bails** on what it can't resolve (safe) rather than pretending to resolve it.
- **Fixed YOLO default (no posture knob).** Rejected on the 2026-06-03 revision: a fixed-approve default leaves the *cautious* operator unable to express "allow these few, ask about the rest" without block-listing every danger. The `on_unmatched` knob is what makes both intents expressible with a small list.
- **Deferring `auto_approve` to a later version ("ship gate-only, see who shouts").** Raised on the revision and **rejected**: `auto_approve` *is* the cautious operator's allow-list; without it they must exhaustively block-list — manufacturing the very "gate 25 args" failure we set out to avoid. Shipping half the policy model and waiting for complaints is the anti-pattern. Full narrative in the reply note.
- **Head-level `auto_approve` (bless by program name only).** Rejected: blessing `npm` auto-approves `npm publish` as readily as `npm test` — a real hole for the very operator who chose caution. Lifted to subcommand/phrase level (which generalises head-level: a one-word phrase is head-level).
- **Two different grammars per list** (`tool:word` for `gate`, bare heads for `auto_approve`). Rejected as the original bug: one grammar (`<tool>` or `bash:<phrase>`), bare = tool, for both lists.
- **Persist the inbox to disk + re-attach on restart (v0-spec wording).** Rejected: the asking pi process is dead after a restart, so a persisted pending request is unanswerable. In-memory + re-ask is the honest model; decisions are logged for audit.
- **Auto-answering `select` to "first option."** Rejected: there is no safe affirmative default for a choice; `select`/`input`/`editor` always go to a human.
- **`auto_approve` simple-commands-only (option A).** Considered and deferred *against*: chosen the fuller fail-closed **segment/phrase** extractor (option B) for better day-one UX (blessed compounds + subcommand precision), since the extractor fails safe by construction.

## Consequences

- **New module + new primitive:** a pure shell-aware matcher in `approvals/matcher.ts` (`gate` over-match tokenizer + `auto_approve` fail-closed segment/phrase extractor + the `<tool>`/`bash:<phrase>` descriptor parser), the `approvals/router.ts` wiring over the stub, and `Supervisor.send()` / `serializeJsonLine` in `util/jsonl.ts`. The matcher is the most logic-dense piece in pid; it gets its own focused tests pinned to the worked tables above.
- **Schema:** `gate` / `auto_approve` already exist as `string[]`; their *semantics* are now defined (`<tool>` or `bash:<phrase>`, asymmetric matching). **Add `on_unmatched: z.enum(["approve","ask"]).default("approve")`** (mirrors the `on_exceed` precedent). Load-time validation should reject a descriptor whose bare token isn't a known pi tool (catches `gate: [rm]` typos early).
- **Structured matching depends on correlation**, which assumes the dialog follows the tool it gates (true for the documented `tool_call` → `ctx.ui.confirm` flow). Free-standing dialogs are handled (enqueue), but a mis-correlation is possible if an extension interleaves unrelated dialogs with tool execution — acceptable, fails toward asking.
- **Docs must change** (docs-as-spec): the `gate`/`auto_approve` examples and the "approvals persist" line in `intro.md` / `extensions-with-pid.md` / `v0-spec.md` need the corrected model, plus the operator guidance above. Update docs first.
- **Daemon dispatch:** wires the remaining `approvals` / `approve` / `deny` commands (currently `not implemented`).

## Revisit when

- A real extension needs richer policy than `<tool>` / `bash:<phrase>` (e.g. non-bash arg/path matching like `write:/etc/*`) → extend the descriptor per-tool; keep the over/under asymmetry and the fail-closed rule for the allow side.
- Delivery channels beyond the CLI (Slack/web/mobile) arrive (v0.2) → the inbox grows a notifier; the router core is unchanged.
- `pikg` (capability-scoped tools) lands → much tool-gating moves there; approvals narrow to genuine human-judgment dialogs.
- pi changes the extension-UI protocol (watched via `/refresh-pi`) → update the verified shapes + the `send()` framing.
- **The observability mandate becomes active (top post-core deliverable, NON-NEGOTIABLE — Steven 2026-06-03).** Once the three v0 consumers are built: (a) extend the `pid_*` chronicle to **all** interventions — add `pid_quarantine` to the crash detector and `pid_budget_pause`/`pid_budget_resume` to the cost governor (they emit no synthetic event today); (b) **document the full per-service log schema** as a versioned public contract in `v0-spec.md` so third parties can build dashboards / integrate with existing pi dashboards; (c) build an **example GUI/dashboard** plus **log retention/rotation + an index/query layer** for fast filtered views (raw jsonl stays the source of truth; speed comes from the index). See workspace `CLAUDE.md` "Highest-priority post-core deliverable" + memory `observability-mandate`.

## References

- Verified protocol: `pi/packages/coding-agent/docs/rpc.md` (Extension UI), `src/modes/rpc/rpc-types.ts`, `rpc-mode.ts`; `jsonl.ts` (`serializeJsonLine`).
- The no-tool-veto finding: `core/agent-session.ts` (`beforeToolCall`), `core/extensions/runner.ts` (`emitToolCall`), `packages/agent/src/agent-loop.ts` (tool_execution_start timing).
- `pid/docs/v0-spec.md` — "Product: approval inbox"; ADR 0002/0003 (the two prior consumers; in-memory-state precedent).
