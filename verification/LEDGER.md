# pid verification ledger

Every load-bearing claim, resolved against the **real `pi` binary** with a re-runnable receipt — or honestly marked unverifiable. See `PLAN.md` for method. Re-run any receipt yourself: `bash verification/scenarios/<id>.sh`.

**Environment:** receipts stamped per-run with `pi --version` + reference-clone head (in each `captures/<id>.meta`). As of CP0: pi **0.78.1**, clone `130ae577`.

Verdicts: **verified** (real receipt) · **fixed** (was wrong → fixed + receipt) · **refuted** · **unverifiable-by-run** (reason given; never faked).

## Findings

- **#0 — pi binary/version drift.** The installed binary was **0.76.0** while our reference clone (all "pi-source congruence" checks) was **0.78.1** — two weeks of source refs were against newer code than the binary that runs. Surfaced at CP0; the per-run version stamp caught it automatically (S1 receipt reads 0.76.0, S2 reads 0.78.1 — pi self-updated mid-session). **Resolved:** user upgraded the binary to 0.78.1; binary now matches the clone. *Discipline proven: receipts stamp the version, so drift can never hide again.*
- pi prints `--version` to **stderr**, not stdout (harness now captures `2>&1`). Minor, recorded for accuracy.

## Ledger

| # | Claim (source) | Current impl (file:line) | pi-source ref | Expected (pre-run) | Actual (receipt) | Verdict |
|-|-|-|-|-|-|-|
| 1 | The agent receives its task so a service actually runs | `supervisor/index.ts` start() sends `{type:"prompt",message}` after spawn | `rpc-types.ts:21`, `docs/rpc.md` "Prompting" | spawn → real LLM turn → `agent_end` | `s1`: `agent_start→turn→message_end→agent_end`, real reply, 1427 tok | **fixed** (was: never sent → idle agent; before/after proven) |
| 2 | Cost governor charges real token usage per `message_end` | `governor/cost.ts:92-120` `extractUsage` (role==="assistant"; tokens = input+output+cacheRead+cacheWrite) | real assistant `message_end.message.usage` = `{input,output,cacheRead,cacheWrite,totalTokens,cost{…,total}}` + `message.timestamp` | tokens>0 metered against the window | `s1`: budget `tokensDay` = 1427 (= the four-component sum) | **verified** (token path; USD → CP7) |
| 3 | Crash detector derives `tool:<name>:error` from a failed tool event | `governor/crash.ts:77-83` (`isError!==true`→null; `toolName`) | real `tool_execution_end` = `{type,toolCallId,toolName,result:{content,details},isError}` | a failing read → `isError:true, toolName:"read"` | `s2`: `{toolName:"read",isError:true}` present | **verified** (input shape; full quarantine flow → CP3) |
| 4 | Crash detector derives `agent:error` only when pi truly gave up | `governor/crash.ts:89-97` (`willRetry!==false`→null; last assistant `stopReason==="error"`) | real `agent_end` = `{type,messages[],willRetry}`; `stopReason` on the message, `willRetry` set by pi `_willRetryAfterAgentEnd` (`agent-session.ts:549`) | bad model → errored turn → last assistant `stopReason:"error"`, `willRetry:false` → `deriveSignature`→`agent:error` | `errored-turn`: 1 `agent_end`, `willRetry:false`, `stopReason:"error"` (`400 Unknown Model`), **real compiled `deriveSignature` → `agent:error`** | **verified** (full quarantine flow → CP3) |
| 5 | Governor pauses a service that breaches a token cap on **real** spend | `governor/cost.ts:350-367` `charge`→`evaluateBreach`→`pause()` | real assistant `message_end.usage` (the 4-component sum) | low `daily_tokens:50` → 1 real turn breaches → service paused | `s5`: 1432 tok > 50 → `pid_budget_pause`; `budget show` → `paused:true`, breached `daily_tokens` | **verified** (CP2; USD caps → CP7) |
| 6 | `pid_budget_pause` payload matches the documented contract (ADR 0007) | `governor/cost.ts:374-385` `logPause`; supervisor `logBudgetPause` | the v0-spec "Log line schema" row | `{breached:[{cap,limit,spent,windowEnd}],resumeAt,by:"governor"}`, source `pid` | `s5`: exact match — `daily_tokens`/50/1432/midnight, `resumeAt`=windowEnd, `by:"governor"` | **verified** |
| 7 | `pid budget reset` zeroes the window accounting (real daemon) | `governor/cost.ts:281-292` `reset`; `budget/store.ts` `reset` | — (pid-native) | reset → `tokensDay` back to 0, still paused | `s5`: `budget reset` → `tokensDay:0` | **verified** |
| 8 | Crash detector quarantines on **real** repeated same-tool failures (full flow) | `governor/crash.ts:163-184` `record`→`quarantine()` | real `tool_execution_end{isError,toolName}` ×N in-window | 3 failing reads → terminal quarantine, pi stopped | `s3`: 3× `tool:read:error` → `pid_quarantine`; `status` → `state:"quarantined"`, no pid | **verified** (CP3; rows 3/4 input shapes now exercised end-to-end) |
| 9 | `pid_quarantine` payload matches the documented contract (ADR 0003/0007) | `governor/crash.ts:176-182` `logQuarantine` | v0-spec "Log line schema" row | `{signature,count,threshold,windowSeconds,by:"crash_detector"}` | `s3`: exact — `tool:read:error`/3/3/300/`crash_detector`, written right after the 3rd failing read | **verified** |
| 10 | `extension_ui_request` shapes match pi's RPC types | `approvals/router.ts` `route`; `approvals/matcher.ts` | pi `rpc-types.ts:214-215` (`confirm{title,message}`, `select{title,options}`) | real dialogs carry those exact fields | `s4-confirm`: `{method:"confirm",title,message}`; `s4-select`: `{method:"select",title,options:["approve","deny"]}` | **verified** |
| 11 | The approval **round-trip** works through a real pi extension (the OTHER `send()` path) | `router.ts:173-188` `approve`→`actions.send`; supervisor `send()` | pi accepts `extension_ui_response` on stdin (`rpc-mode.ts:720-734`, `rpc-types.ts:256-257`) | enqueue → `pid approve` → pi continues, gated bash runs | `s4-confirm` & `s4-select`: `tool_execution_start→extension_ui_request→pid_approval enqueue→resolve(by:cli)→tool_execution_end bash isError:false` | **verified** (the sibling of the prompt-delivery gap) |
| 12 | pid's reply framing is accepted by real pi | `router.ts:177,234` `buildApproveReply` | `{id,confirmed:true}` (confirm) / `{id,value}` (select) | pi resumes the gated tool, no timeout/error | `s4-confirm`: `{confirmed:true}` → bash ran; `s4-select`: `{value:"approve"}` → bash ran | **verified** |
| 13 | A real `-e` extension loads + fires UI under `pi --mode rpc` (`hasUI` true; trust not blocking) | `extensions:` YAML → `buildPiArgs` `-e`; pi `runner.ts:319/370` | RPC installs a real (non-noOp) UI context | dialog actually fires (not blocked/dropped) | `s4`: `extension_ui_request` emitted; `ctx.hasUI` effectively true; `-e` abs path not dropped by A6 trust gating | **verified** (resolves an A6 worry for approvals) |
| 14 | pi's teardown exit-code contract (the premise behind pid's stdin-close stop) | `supervisor/index.ts:351` `stop()` (stdin-close, not SIGTERM) | pi `rpc-mode.ts:694` `if (signal !== "SIGTERM") flushRawStdout()` then `exit(code)` | stdin-close → exit 0 (flush); SIGTERM → exit 143 (skip) | `s6` Part A (direct, no daemon): `{code:0}` and `{code:143}` | **verified** (was source-only; now empirical) |
| 15 | `pid stop` → clean stop, full chronicle, no synthetic exit event | `supervisor/index.ts:351` `stop()`; `finalizeExit` | clean stop yields code 0 → state `stopped`; ADR 0012 | state `stopped`, `agent_end` survived, last line parses, no `pid_service_exit` | `s6` Part B: all four hold | **verified** |
| 16 | `pid reload` stages a modified **running** service without interrupting it (ADR 0010) | `supervisor/index.ts:477` `reload`; `:498-501` `pendingConfig`+`pid_config_changed` | pi `/reload` rule: never interrupt running work (xref `dc7b547f`) | modified-running → `staged`, **pid unchanged**, `configChanged:true`, `pid_config_changed` event | `s7`: `staged:[keep]`, pid `53821` unchanged, event written | **verified** |
| 17 | A staged definition is adopted on the service's next start | `supervisor/index.ts:200-202` `start()` adopts `pendingConfig` | — (pid-native) | restart keep → new prompt (B) takes effect, `configChanged` clears | `s7`: `PID-VERIFY-S7-B` in chronicle post-restart; `configChanged:false` | **verified** |
| 18 | reload registers a new file and orphans a removed running service | `supervisor/index.ts:478-525` reconcile buckets | — (pid-native) | new file → `added`; removed-while-running → `orphaned` (left running) | `s7`: `added:[fresh]`; `orphaned:[keep]`, keep still running, `orphaned:true` | **verified** |

## CP1 — reconciliation (captures × fixtures × consuming code × pi-source)

Method: diff each CP0/CP1 capture against (a) the fakes/test fixtures, (b) the consuming code, (c) the cited pi-source. Every load-bearing read path now matches a real capture; the fakes were made byte-faithful so they can never again be "more generous" than real pi (the drift class that hid the original gap).

**(b) consuming code — all read paths match real bytes:**
- `extractUsage` reads `message.role==="assistant"` + `message.usage.{input,output,cacheRead,cacheWrite}` + `cost.total` + `message.timestamp` — every field present & correctly typed in the s1 assistant `message_end` (the user-echo `message_end` carries no usage and is correctly skipped). ✓
- `deriveSignature` tool path reads `isError`+`toolName` at the top of the raw event — matches s2 `tool_execution_end`. ✓
- `deriveSignature` agent path reads top-level `willRetry` + walks `messages[]` for the last assistant `stopReason` — matches the errored-turn `agent_end`. ✓
- Consumers receive pi's **raw** event; the on-disk chronicle wraps it as `{v,ts,service,source,type,data}` with `data` = the raw event. The two never confused. ✓

**(a) fixtures — drift found & fixed (none was load-bearing, but all removed):**
| Fixture | Field | Was | Real pi | Fix |
|-|-|-|-|-|
| `fake-pi-crasher.mjs` | `tool_execution_end.result` | `"command not found"` (string) | `{content:[{type,text}],details}` (object) | fixed → object |
| `crash.test.ts` `toolEnd` | `result` | `"..."` (string) | object | fixed → object |
| `fake-pi-spender.mjs` | `usage.totalTokens` | absent | present | added |
| `fake-pi.mjs` | assistant `message_end.usage` | `{cost:{total}}` only | full 4-component + totalTokens + cost | completed |

**(c) pi-source — confirmed semantics behind the guards:**
- `willRetry` = pi's `_willRetryAfterAgentEnd` (`agent-session.ts:549`): true only if retry enabled, attempts not exhausted, and the last assistant message is a *retryable* error. So `willRetry===true` ⇒ pi will re-run ⇒ pid's `willRetry!==false` guard correctly skips it. Default retries: enabled, maxRetries 3.
- `stopReason==="error"` is the genuine-failure marker; `"aborted"` is an interruption (pid's own pause/stop) — pid's guard counts only `"error"`. ✓
- Non-retryable errors (provider quota/billing, `_isNonRetryableProviderLimitError`; 4xx like the `400 Unknown Model` we forced) ⇒ `willRetry:false` immediately — the forcing function for the errored-turn capture.

**Findings (non-blocking):**
- The four token components summed to `totalTokens` exactly in every captured `message_end` (s1: 58+25+1344+0 = 1427 = totalTokens). pid intentionally charges the four-component **sum** and ignores `totalTokens` (ADR 0002), so even a future divergence is safe by construction. The earlier ledger numbers (1410/1420) were from the pre-self-update 0.76.0 run; the committed 0.78.1 capture is 1427.
- Streaming frames (`message_update`, `tool_execution_update`) are dropped from the chronicle by design (ADR 0009 `persistsToChronicle`), so they are absent from every capture and their **inner** shape is not run-verifiable from the chronicle. This is acceptable: no consumer reads their inner shape — only their `type` (to drop them); the final content is in the `*_end` events. *(If ever needed, a raw-stdout capture would verify them — `unverifiable-from-chronicle` by design, not a gap.)*

## CP2 — cost governor on real token spend (`s5-budget-pause.sh`)

Whole real path proven through the live daemon: real `message_end.usage` → `extractUsage` → `BudgetStore` → `evaluateBreach` → `pause()` → `pid_budget_pause` on the chronicle → service held paused → `budget reset` zeroes it. Receipt: `bash verification/scenarios/s5-budget-pause.sh`.

- **Sequencing observation (ground truth):** in a single-turn service the `pid_budget_pause` lands *after* `agent_end` — the turn completes before the governor's async charge resolves. This still honours the ADR 0007 "logged before the stop" contract (it is written while the stream is open, then `stop()` runs); the relative order vs `agent_end` is not part of the contract. A continuous/multi-turn service would be interrupted mid-stream instead.
- **Out of scope (pure, not re-run with real pi):** the auto-resume **timer** firing at the next window rollover, and the window-roll/DST math — these are injected-clock unit tests (`governor.test.ts`, `time.test.ts`) and never touch pi's runtime. A black-box live daemon uses the real wall clock, so the rollover can't be elicited in a receipt without adding test-only clock plumbing to the daemon (rejected — a new abstraction, not warranted). The real-pi boundary (does genuine spend trigger the pause + the documented event) is what CP2 verifies, and it does.
- USD caps (`daily_usd`/`weekly_usd`) and `cost.total` enforcement remain deferred to CP7 (zai reports `$0`); the token path is independent and now verified.

## CP3 — crash quarantine on real repeated failures (`s3-crash-quarantine.sh`)

Real pi was driven to read five nonexistent files one tool-call at a time; each produced a genuine `tool_execution_end{isError:true,toolName:"read"}` → signature `tool:read:error`. At the 3rd identical failure the crash detector wrote `pid_quarantine` (right after that `tool_execution_end`, before the graceful stop) and quarantined the service. `pid status` confirms the terminal `quarantined` state with no live pid. Receipt: `bash verification/scenarios/s3-crash-quarantine.sh`.

- **Graceful-stop observation:** the quarantine's `stop()` closes stdin, so pi finishes its in-flight turn (a couple more events appear after `pid_quarantine`) before shutting down — expected, and the quarantine event is correctly sequenced before the stop completes.
- The `proc:exit_*` signature remains deferred (no relauncher exists to make a dead process *loop*; ADR 0003 decision 4) — unchanged by this checkpoint.

## CP4 — approval round-trip through a real pi extension (`s4-approval.sh [confirm|select|input|editor]`)

The most important checkpoint: it exercises the OTHER host→pi `send()` path — pid writing `extension_ui_response` back to pi — the sibling of the prompt-delivery gap that started this remediation. A **real** pi extension (`verification/extensions/pid-verify-ui.ts`, a comprehensive env-driven gate covering all four blocking dialog methods, loaded via the `extensions:` YAML → `-e`) raises a dialog on the bash tool; pid's router enqueues it; `pid approve` replies over stdin; pi accepts the reply and the gated bash completes. Receipts: `bash verification/scenarios/s4-approval.sh confirm` and `… select`.

- **Real shapes captured for the first time:** `confirm` = `{id,method:"confirm",title,message}`; `select` = `{id,method:"select",title,options[]}` — both exactly pi's `rpc-types.ts:214-215`.
- **Operator path proven:** `pid_approval` `enqueue`→`resolve{decision:"approve",by:"cli"}`; pi resumed (`tool_execution_end` bash `isError:false`) for both `{confirmed:true}` (confirm) and `{value:"approve"}` (select).
- **`input`/`editor` not run** (one command away: `s4-approval.sh input`/`editor`). They share the `{value}` reply path with `select`, which is verified; the extension already supports them. Recorded so the coverage gap isn't silent.
- **Finding — the trusting/auto-approve path, proven live incidentally:** the first run mis-set the posture (`on_unmatched` is a **top-level** service field, ADR 0004; a nested `approval:` key is ignored → defaults to `approve`). That run still proved real pi behaviour: the router auto-classified (`decision:"auto_approve",by:"policy"`), sent `{confirmed:true}`, and pi continued — so both the trusting auto-approve and the cautious enqueue paths are now real-pi-confirmed. (The matcher *decision* itself is pure logic, exhaustively unit-tested in `matcher.test.ts` against ADR 0004's tables — not re-run.) The mis-set was in the *test scenario*, not pid.
- `fake-pi-approver.mjs`'s `extension_ui_request` shape (`{id,method:"confirm",title,message}`) was already byte-faithful to the real capture — no drift.

## CP5 — lifecycle: stop/shutdown flush + reload-against-running (`s6-stop-shutdown.sh`, `s7-reload.sh`)

- **S6 — exit-code contract proven empirically.** pid's whole stop() rationale (ADR 0001) rested on a *source* claim: stdin-close flushes + exit 0, SIGTERM skips the flush + exit 143. A direct probe of the real binary (`pi-exit-probe.mjs`, no daemon, $0) now confirms both: `{code:0}` and `{code:143}`. The exit codes are the observable proxy for pi's `if (signal !== "SIGTERM") flushRawStdout()` gate — so "stdin-close gets the flush" is now grounded, not assumed. Through pid: `pid stop` → `stopped`, the full turn survived shutdown, the chronicle isn't truncated, and no `pid_service_exit` is synthesized for a clean stop.
  - *Pi emits no terminal "shutdown" event* (the old fake-pi `session_shutdown` line was fictional — the real "flush" is just buffered stdout draining before exit). Deep buffered-truncation on SIGTERM is pi-internal/timing-dependent and not separately elicited; the exit-code contract is the load-bearing observable and it's verified.
- **S7 — reload reconciles a real running process.** All four dispositions in one run: `added` (new file), `staged` (modified-running — **pid unchanged**, the "never interrupt running work" rule), adoption-on-restart (the staged prompt B appears in the chronicle), and `orphaned` (removed-running, left alive + flagged). The same-pid check is the direct proof that a running service is never restarted by reload.

## Open (next checkpoints)

- dashboard/observability fed by a real run → CP6.
- dollars (USD caps, `cost.total`) → CP7 (needs an API model wired on signal; zai reports `$0`).
- regression armor (gated `test:real`, fixture-drift guard) + honest re-baseline of CLAUDE.md / v0-spec → CP8.
