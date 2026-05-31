# 0002 — Cost governor: budget model, pause semantics, windows

- **Status:** Accepted
- **Date:** 2026-06-01
- **Deciders:** Steven (decisions), Claude (analysis)

## Context

The cost governor is the first consumer behind the supervisor's `onServiceEvent` seam. It enforces per-service budgets from pi's event stream. Cost/usage facts, verified against pi @ `3911d6f5`:

- Per-message cost is `event.message.usage.cost.total` on `message_end` where `message.role === "assistant"`, and is **per-message incremental** — summing across a run gives the run total.
- The `Usage` type (`packages/ai/src/types.ts`) has `input / output / cacheRead / cacheWrite / totalTokens / cost`. `totalTokens` is **provider-inconsistent** (Mistral/Bedrock fall back to `input + output` only; Google/OpenAI-responses use native provider counts). pi's own canonical total (`getSessionStats`, `agent-session.ts` ~2946) **ignores `totalTokens`** and recomputes `input + output + cacheRead + cacheWrite`.

## Decisions

1. **Pause semantics (Q1):** on breach, `pause` = graceful `stop()` (ADR 0001); `resume` = `start()` at window reset. Both go through a supervisor `pause(name)` / `resume(name)` seam, so the pause *mechanism* can be swapped without touching the governor.
2. **Caps (Q2):** enforce `daily_usd`, `weekly_usd`, and `daily_tokens`. Tokens counted as `input + output + cacheRead + cacheWrite` (mirrors pi's `getSessionStats`; provider-consistent; reconciles with pi's reported numbers). **Not** `totalTokens`.
3. **Actions (Q2):** `on_exceed` ∈ { `pause` (default), `notify` }. `notify` records the breach and keeps the service running (observation / dry-run on-ramp for calibrating a cap before enforcing it). A breach is **always** surfaced on `pid status`, regardless of action.
4. **Windows (Q3):** daily and weekly are **calendar-aligned in `reset_tz`** (validated at config load), computed from wall-clock midnight via the built-in `Intl`/ICU (DST-correct — a calendar day is sometimes 23h/25h — and no new dependency). Weekly starts **Monday** (ISO 8601). A paused service **resumes at the latest end-of-breached-window**, so breaching the weekly cap does not wrongly resume at the next daily midnight.

## Alternatives considered / deferred (with reasons)

- **Pause option B — abort + keep process warm + suppress new triggers.** Deferred, *not rejected*. Reasons: (a) depends on a trigger layer that does not exist yet — "suppress triggers" has nothing to gate, so it would be correct only by accident and would start leaking spend when the trigger layer lands unless that layer is built budget-aware; (b) its headline benefit (warm provider cache on resume) is ~nil at daily-budget timescales — provider cache TTL (~5 min) ≪ a pause (hours); (c) undefined resume-of-interrupted-work semantics. **Revisit when** the trigger layer exists *and* a sub-window / high-frequency budget use case appears. The governor's detection engine is unchanged by the swap — only the `pause()`/`resume()` implementations change.
- **`daily_tokens` = `totalTokens`.** Rejected: provider-inconsistent (see Context).
- **`daily_tokens` = `input + output` only.** Rejected: undercounts throughput and won't reconcile with pi's reported total.
- **`quarantine` action.** Deferred: would co-own the `quarantined` state with the (unbuilt) crash detector — two owners of one state. Revisit with the crash detector.
- **`notify` delivery channels** (email/Slack/desktop/webhook). Deferred to v0.2: no channel exists; v0 surfaces breaches on `pid status` only.
- **Configurable `week_start`.** Deferred: a trivial preference toggle with no reasoning at risk and no dependency it unblocks. Default Monday; add on request.

## Consequences

- Enforcement is **reactive**: cost arrives on `message_end` *after* the spend, so the governor cannot block the message that crosses the line — only halt the next turn. Inherent to pi's event model.
- Resume is a cold pi session (provider cache lost); acceptable for a daily circuit-breaker.
- New modules: `src/governor/`, `src/budget/store.ts` (`BudgetStore`, per-service `budget/<name>.json`, atomic writes mirroring `StateStore`), `src/util/time.ts` (calendar windows).
- Daemon-restart recovery: `paused` state + `window_end` persist in the budget file; on boot, recover the resume timer (window past → resume now; window future → set timer for the remainder).

## References

- pi cost/usage shape: `packages/ai/src/types.ts` (`Usage`); `packages/coding-agent/src/core/agent-session.ts` ~2946 (`getSessionStats`)
- `pid/docs/v0-spec.md` — "Product: cost governor"
