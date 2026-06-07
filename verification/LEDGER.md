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

## Open (next checkpoints)

- `extension_ui_request` shape + approval round-trip → needs a real pi extension, CP4.
- stop/shutdown flush + exit codes → CP5. reload-against-running → CP5. dashboard on a real run → CP6. dollars → CP7.
