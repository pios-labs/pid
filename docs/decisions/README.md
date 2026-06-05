# Architecture Decision Records

One file per significant architectural decision for `pid` — numbered, append-only. An ADR captures the **context**, the **decision**, the **alternatives considered**, the **consequences**, and **when to revisit**. They exist so the reasoning behind a choice survives long after the conversation that produced it — the antidote to the "compounding booboos" failure mode where undocumented deferrals rot and the *why* is lost between versions.

## When to write one

Write an ADR when a change involves any of:

- a new module or abstraction,
- a new dependency,
- a divergence from pi's own conventions,
- a non-obvious scope or deferral call (something deliberately *not* built, with a real reason).

Routine implementation does not need one — a focused code comment carries implementation-level rationale. The ADR carries the *decision*.

## Status values

`Proposed` · `Accepted` · `Superseded by NNNN`

## Index

- [0001](0001-supervisor-stop-teardown.md) — Supervisor.stop() teardown: stdin-close over SIGTERM — **Accepted**
- [0002](0002-cost-governor.md) — Cost governor: budget model, pause semantics, windows — **Accepted**
- [0003](0003-crash-loop-detector.md) — Crash-loop detector: failure signatures, quarantine, scope — **Accepted**
- [0004](0004-approval-router.md) — Approval router: policy model, matching semantics, host-reply path — **Accepted**
- [0005](0005-log-envelope.md) — Per-service log envelope: one chronicle schema for pi + pid events — **Accepted**
- [0006](0006-cli-human-readable-output.md) — Human-readable CLI output by default; `--json` opt-out (the CLI render pass, D2) — **Accepted**
- [0007](0007-intervention-events.md) — Synthetic intervention events: `pid_quarantine`, `pid_budget_pause`, `pid_budget_resume` — **Accepted**
