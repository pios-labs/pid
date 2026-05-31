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
