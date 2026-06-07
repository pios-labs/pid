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
| 1 | The agent receives its task so a service actually runs | `supervisor/index.ts` start() sends `{type:"prompt",message}` after spawn | `rpc-types.ts:21`, `docs/rpc.md` "Prompting" | spawn → real LLM turn → `agent_end` | `s1`: `agent_start→turn→message_end→agent_end`, real reply, 1410 tok | **fixed** (was: never sent → idle agent; before/after proven) |
| 2 | Cost governor charges real token usage per `message_end` | `governor/cost.ts` (tokens = input+output+cacheRead+cacheWrite) | real `usage` = `{input,output,cacheRead,cacheWrite,totalTokens,cost{…,total}}` | tokens>0 metered against the window | `s1`: budget `tokensDay` = 1410 | **verified** (token path; USD → CP7) |
| 3 | Crash detector derives `tool:<name>:error` from a failed tool event | `governor/crash.ts:80-82` (`isError!==true`→null; `toolName`) | real `tool_execution_end` = `{type,toolCallId,toolName,result,isError}` | a failing read → `isError:true, toolName:"read"` | `s2`: `{toolName:"read",isError:true}` present | **verified** (input shape; full quarantine flow → CP3) |

## Open (next checkpoints)

- usage `input+output+cacheRead+cacheWrite` vs `totalTokens` — equal in S1 (1420=1420); confirm whether pi-source ever diverges them → CP1.
- `agent_end` `willRetry`/`stopReason` shape (crash detector's other trigger) → needs an errored turn, CP1/CP3.
- `extension_ui_request` shape + approval round-trip → needs a real pi extension, CP4.
- stop/shutdown flush + exit codes → CP5. reload-against-running → CP5. dashboard on a real run → CP6. dollars → CP7.
