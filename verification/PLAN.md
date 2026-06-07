# pid verification & recovery plan

**Why this exists.** For two weeks pid was built and tested against *fake pi* fixtures that emitted events unprompted. That hid a fundamental gap — pid never delivered the prompt, so a real service spawned an idle agent and did nothing — while every test stayed green. This plan re-establishes every load-bearing claim against the **real `pi` binary**, with reproducible receipts, and makes that failure mode impossible to repeat.

## The governing rule

> Ground truth is what **real `pi` actually emits**, captured to a file. No claim is "verified" without a **reproducible receipt** from a real run. We write the expectation *before* the run; the diff between expectation and reality is the finding. Tests assert against captured real behaviour, never against assumptions. Where a claim genuinely cannot be elicited by a live run, the verdict says so — we never fake a receipt to make a row green.

## Scope — be ruthless about this

The failure was at the **pi-runtime boundary**. That is where the effort goes. Pure internal logic that never touches pi's runtime is already validly unit-tested against deterministic inputs and is **not** re-verified with real pi (it is listed below so the exclusion is explicit, not silent).

**In scope (real-pi receipts required):**
- spawn + `buildPiArgs` output actually accepted by real pi
- prompt delivery (`{type:"prompt"}`) — the gap we just fixed
- event-stream **shapes** every consumer reads: `message_end.usage`, `tool_execution_start/end` (+`isError`), `agent_end` (`willRetry`/`stopReason`), `extension_ui_request`
- cost governor enforcement on **real token spend** (+ window roll/reset via injected clock)
- crash-loop quarantine on **real** repeated failures
- approval router round-trip through a **real pi extension** (`send()` reply accepted by pi)
- `stop()`/shutdown: stdin-close flush + exit codes; SIGTERM path
- `reload` against a **real running** process
- observability: chronicle + `pid_*` events + dashboard fed by a real run

**Out of scope (already unit-tested, pure, no pi runtime — NOT re-run):**
- approval matcher grammar (`matcher.ts`) · CLI renderers/prompts (`cli-render.ts`, `cli-prompt.ts`) · resume-arg parsing · YAML/Zod schema validation (except: `buildPiArgs` *output* is checked against real pi in S1) · state-store persistence · log envelope/rotation file mechanics. These get a one-line "pure, unit-tested, not re-run" note in the ledger, nothing more.

## Two artifacts

1. **Receipts** — `verification/scenarios/*.sh` (each standalone-runnable) + `verification/captures/*.jsonl` (the raw bytes real pi produced). `verification/run-all.sh` runs every scenario in sequence (the wider-workflow check). Every receipt records `pi --version` + pi-clone HEAD.
2. **Ledger** — `verification/LEDGER.md`: one row per in-scope claim, six fields: *Claim (source) · Current impl (file:line) · pi-source ref (pi/…:line) · Expected (written pre-run) · Actual (receipt link) · Verdict (verified / fixed / refuted / unverifiable-by-run+reason)*.

## Determinism strategy

A real LLM is non-deterministic, so receipts assert on **structure and side-effects**, never model prose: an event type is present, a field has the expected shape, tokens > 0, a service paused, pi accepted a reply and continued. Where a specific event must appear, a **forcing function** (a controlled prompt or a purpose-built extension) elicits it reliably. Each scenario names its forcing function.

## The scenarios (each is a receipt; one run verifies many claims)

| ID | Real-pi scenario | Forcing function | Verifies (claims/ADRs) |
|-|-|-|-|
| S1 | basic prompt → reply | `"Reply with exactly: PID-LIVE-OK"` | spawn, `buildPiArgs` accepted, prompt delivery, event stream, `message_end.usage` token shape, chronicle capture, clean `agent_end`, `--session-id` |
| S2 | tool call (ok) + tool error | `"read ./present.txt then read /nonexistent"` | `tool_execution_start/end` shapes, `isError` shape → crash signature input; governor charge per `message_end` |
| S3 | crash-loop → quarantine | a prompt reliably repeating the same failing tool, low `same_failure_threshold` | crash `deriveSignature` vs real events, in-window count, real `quarantine()` + `pid_quarantine` (ADR 0003/0007) |
| S4 | approval round-trip | a **minimal real pi extension** firing confirm/select/input dialogs | `extension_ui_request` shapes, router correlation/enqueue, `send()` reply framing accepted by pi, `pid_approval` (ADR 0004) |
| S5 | budget pause (tokens) + window roll | low `daily_tokens`, real spend; injected clock crossed past `dayEnd` | governor enforcement on real tokens, `pid_budget_pause`, auto-resume window math, DST instant (ADR 0002/0007) |
| S6 | stop + shutdown flush | real running pi → `stop()` (stdin close); separate SIGTERM run | final flushed events captured, exit 0 vs 143, no truncation (ADR 0001 / D2) |
| S7 | reload running service | real running service; edit its YAML; `pid reload` | reconcile dispositions vs a real process, staged config adopted on restart (ADR 0010) |
| S8 | dashboard/observability | facade pointed at the real daemon during S1–S5 | real events + `pid_*` + token cost stream to UI; `pid_service_exit` on a real failure (ADR 0008/0011/0012) |

**$ deferred:** every USD-dependent assertion (`message_end.usage.cost.total`, `daily_usd`/`weekly_usd` enforcement) is collected into **one** checkpoint (CP7) so the API model is wired once. The zai subscription reports `$0` cost / real tokens — confirmed S1.

## Checkpoints (each = runnable receipt(s) + ledger rows + any fixes committed; you can stop and inspect at any)

- **CP0 — ground truth.** Run S1 + S2; capture the raw event corpus. Output: `captures/` + the real shapes of `usage` / `tool_execution_*` / `agent_end`. *Proof: the JSONL files, re-runnable by you.*
- **CP1 — reconcile.** Diff captures against (a) the fixtures, (b) consuming code, (c) cited pi-source. Fix every mismatch; rewrite fixtures to mirror captures. *Proof: a reconciliation table + the fixes, each linked to a capture line.*
- **CP2 — cost governor (tokens).** S5 minus dollars. *Proof: real spend → real pause → clock-advance → reset, all in one re-runnable script.*
- **CP3 — crash quarantine.** S3. *Proof: real repeated failures → real quarantine + chronicle event.*
- **CP4 — approvals.** Build the minimal real extension; S4. *Proof: real dialog → inbox → approve/deny → pi continues.*
- **CP5 — lifecycle.** S6 + S7. *Proof: flush-on-stop receipt; reload-against-running receipt.*
- **CP6 — observability.** S8. *Proof: real run rendered live in the dashboard.*
- **CP7 — dollars (you wire an API model on my signal).** All USD assertions in one pass. *Proof: real cost.total charged → USD cap pause.*
- **CP8 — regression armor + honest re-baseline.** Gated `npm run test:real` (skips without auth, tiny prompts); fixture-drift guard (units fail if a fixture diverges from its capture); finish `LEDGER.md`; rewrite CLAUDE.md status + v0-spec to verified reality; append ADR corrections. *Proof: the ledger, fully resolved; the gated suite green on a real run.*

## Order & efficiency

Strict order CP0 → CP1 first (captures unblock everything and surface the hidden bugs). After that, feature checkpoints CP2–CP6 are independent and run fastest in the S-table order. CP7 batched. CP8 last. Efficiency commitments: reuse one capture across many ledger rows; never re-run pure logic; tiny prompts to spare quota; one dollar session; three artifacts only (scenarios, captures, ledger) — no ceremony beyond them.

## What "done" means now

A claim is done when its ledger row links a receipt you can re-run yourself, or honestly says why it can't be run-verified. "v0 / almost ready" gets re-stated only against the finished ledger.
