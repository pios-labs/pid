# 0001 — Supervisor.stop() teardown: stdin-close over SIGTERM

- **Status:** Accepted
- **Date:** 2026-05-31
- **Deciders:** Steven (decision), Claude (analysis)

## Context

`Supervisor.stop()` must terminate a supervised `pi --mode rpc` child cleanly. pid exists to observe pi's event stream — including the closing cost/usage events — so teardown must not lose pi's final output.

pi has three clean-shutdown triggers, all of which run `runtimeHost.dispose()` (extension cleanup) but differ on whether they flush stdout (verified against pi @ `3911d6f5`, `packages/coding-agent/src/modes/rpc`):

- **stdin EOF** → `shutdown(0)`: dispose, **flush stdout**, exit 0 (`rpc-mode.ts` ~756, `onInputEnd`)
- **SIGTERM** → `shutdown(143)`: dispose, **skip flush**, exit 143 — the gate is `if (signal !== "SIGTERM") await flushRawStdout()` (`rpc-mode.ts` ~693)
- **SIGHUP** → `shutdown(129)`: dispose, flush, exit 129

`abort` (`{"type":"abort"}`, `rpc-mode.ts` ~423) is **not** a shutdown — it cancels the current agent turn only; the process keeps running.

## Decision

`stop()` closes the child's stdin, taking pi's `onInputEnd → shutdown(0)` path: dispose + flush + exit 0, with our stdout reader kept attached so the flushed tail lands in the log. If pi does not exit within a grace period, fall back to **SIGTERM → SIGKILL** (pi's own `RpcClient.stop()` teardown, `rpc-client.ts:143-165`).

## Alternatives considered

- **SIGTERM-only** (mirrors pi's `RpcClient.stop()` exactly): simplest and the strongest single precedent, but `shutdown(143)` skips the flush and can truncate pi's final events — unacceptable for an accounting supervisor. Rejected.
- **abort-first** (the original `v0-spec` wording): based on a misreading — `abort` is not a shutdown. Rejected; spec corrected.

## Consequences

- Deliberate divergence from pi's bundled client — justified because that client is ephemeral and discards late output, whereas pid captures it.
- Clean exit 0 is an unambiguous "stopped on purpose" marker for the future crash detector (vs SIGTERM's 143).
- Relies on pi continuing to treat stdin EOF as a shutdown request.

## Revisit when

- pi makes SIGTERM also flush (drops the `signal !== "SIGTERM"` guard) → SIGTERM-only becomes equivalent and simpler.
- pi stops treating stdin EOF as shutdown → this degrades to the SIGTERM fallback on every stop; watch for that regression.

## References

- Full rationale + source line refs: the doc comment on `Supervisor.stop()` in `pid/src/supervisor/index.ts`
- `pi-upstream-status.md` — D2 (revised), A5
