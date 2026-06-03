# Reply to future-me — the approval-router grammar question (and the bigger thing under it)

*A narrative companion to ADR 0004. Written 2026-06-03, the session before increment B is built. If you're picking up the approval router, read this once, then build from ADR 0004.*

Hey. You opened increment B, went to write the matcher, and hit a real snag: the two worked examples in ADR 0004 used **two different descriptor grammars** and the ADR never said which was canonical. You were right to stop. Here's the definitive answer — and then the part you didn't expect, because pulling that thread unravelled something bigger that materially improved the design. Both are now folded into ADR 0004; this note is the *why* and the *story*, so the reasoning survives.

## 1. The grammar — definitive

**One grammar, both lists: a descriptor is `<tool>` or `bash:<phrase>`.**

- `<tool>` — an exact pi tool name (`bash`, `read`, `write`, `edit`, `grep`, `find`, `ls`). Matches when the correlated `toolName` equals it. **A bare token is *always* a tool name, never a command word.** So `gate: [rm]` means "the tool `rm`", which doesn't exist → never matches. To act on the `rm` *command* you must write `bash:rm`.
- `bash:<phrase>` — the bash tool **and** `<phrase>` (one or more **space-separated** words), matched on whole tokens. `bash:rm` → token `rm`. `bash:git push` → consecutive tokens `git` then `push`. The `:` form is **bash-only in v0** (bash is the only tool whose argument is a command language).

The `auto_approve: [cd, ls, rm, npm]` table was simply the **bug** — bare heads parse as nonexistent tools. It should have been `bash:cd, bash:ls, …`. And the docs' hyphenated `bash:git-push` was also wrong: `git push origin` has no `git-push` token, so it matched nothing. Use a **space** (`bash:git push`); hyphens stay literal so `bash:docker-compose` correctly matches the single token. One-liners:

- A `gate` entry is `<tool>` (act on every dialog for that tool) **or** `bash:<phrase>` (a bash command containing that phrase).
- An `auto_approve` entry uses the **identical** grammar; the difference is purely in *how* it's matched (below), not in the descriptor form.

That alone unblocks the matcher. But here's the thread it pulled.

## 2. The thread: "when does `auto_approve` ever fire?"

The grammars drifted apart because `gate` was written as `tool:word` and `auto_approve` as bare-heads. Reconciling them forced the question we'd *never actually asked* in the original design session: **under our YOLO default, when does `auto_approve` fire at all?**

We had been heads-down on the *mechanics* of matching compounds safely (the `cd && rm` footgun, the `alarm`/`rm` substring trap, the all-heads rule) and never traced the *usage*. When I did, the answer was uncomfortable: under a **fixed** YOLO default + per-service config, `auto_approve` does nothing in the recommended (targeted block-list) setup — everything not gated is already approved. Its *only* effect was in the broad-gate-then-carve-out config… which our own dos/don'ts told people **not** to use. We had built careful machinery for a pattern we disowned.

## 3. The detour I want you to know about: "defer auto_approve" — raised and REJECTED

My first instinct was the wing test: if `auto_approve` only serves a discouraged pattern, cut it — ship gate-only, simplest/safest increment B. I argued that for a couple of rounds. **It was wrong, and I want you to see why so you don't re-make it.**

Steven pushed back (correctly) with the real UX requirement: *no system where you must gate a whole tool then approve a zillion harmless args, or approve a whole tool then gate a zillion destructive ones.* Tracing that against first principles surfaced the actual structure:

There are **exactly two operator intents**, mirror images:

- **Trusting:** "run freely, stop for the dangerous few" → a small **block-list** (`gate`).
- **Cautious:** "only do these few things, ask about the rest" → a small **allow-list** (`auto_approve`).

The two nightmares map one-to-one onto being forced to use the **wrong-sided list** for your intent. And `auto_approve` *is* the cautious operator's allow-list. **Deferring it doesn't simplify — it removes the cautious operator's only small-list option and forces them to exhaustively block-list every danger.** That is literally one of the two failures we set out to prevent. So "defer" would have manufactured the bug. Building `auto_approve` was right all along; I'd just lost the plot by obsessing over the mechanics instead of the intents.

Lesson banked: when in doubt about whether a policy lever earns its place, **trace the user intents, not just the matching mechanics.** We'd validated *how* it matches without checking *whether anyone reaches for it*. Don't skip the second question.

## 4. What the trace fixed (two real gaps in the original ADR)

Serving *both* intents with a small list each needed two changes beyond the grammar:

**(a) A posture knob: `on_unmatched: approve | ask` (default `approve`).** A *fixed* YOLO default can't express the cautious intent cleanly. With the knob:
- Trusting: `on_unmatched: approve` (default) + `gate: [bash:rm]` → "just block rm", one line, nothing else enumerated.
- Cautious: `on_unmatched: ask` + `auto_approve: [bash:npm test, bash:git status]` → "only these, ask about the rest", short allow-list, zero dangers researched.

The symmetry is the tell it's right: `gate` over-matches, `auto_approve` under-matches — **both bias toward "ask"** — and `on_unmatched` just sets the baseline they push against.

**(b) `auto_approve` matches at subcommand/phrase level, not head level.** The original "every *head* blessed" was too coarse to be *safe*: blessing `npm` auto-approves `npm publish` (ship-your-secrets) as readily as `npm test`. The rule is now: a command auto-approves iff it **parses cleanly and every `&&`/`;`/`|` segment's leading words prefix-match a blessed phrase** (substitution/`$VAR`/`eval` → bail to "ask"). `bash:npm test` blesses `npm test --watch` but not `npm publish`. A one-word phrase (`bash:npm`) still means "all npm", so this strictly generalises head-level. Bonus property: the cautious posture **fails closed** on anything unparseable, so it's genuinely *stronger* than trusting-mode block-listing (which is best-effort against obfuscation) — which is exactly why a security-minded operator would choose it.

## 5. What did NOT change (so you don't think we rebuilt the world)

The whole spine is intact: pid only answers `extension_ui_request` (no tool veto); correlation by in-flight tool; only `confirm` is auto-answerable (`select`/`input`/`editor` always enqueue; fire-and-forget logged); free-standing dialogs enqueue; in-memory session-scoped inbox; timeouts expire; `send()` / `serializeJsonLine` as the new stdin primitive. And the compound-safety insight we sweated over is preserved: `gate` over-match catches `rm` anywhere in `cd && rm`; `auto_approve` requires *every* segment blessed so nothing rides in on a blessed head's coattails.

## 6. So, to build increment B

Build against the **revised** ADR 0004 (§§1–3, 6, 10, the worked table, the guidance). Concretely the matcher needs:

1. **Tokeniser** (shared): split a bash command on whitespace + shell metacharacters, quote-aware; whole-word tokens.
2. **`gate` (over-match):** for each `gate` entry — `<tool>` → `toolName ===`; `bash:<phrase>` → phrase appears as consecutive tokens anywhere. Any hit → enqueue. No clean-parse requirement (over-approximate freely).
3. **`auto_approve` (under-match, fail-closed):** split the command into `&&`/`;`/`|` segments (quote-aware); if any segment contains substitution/backtick/`$VAR`/`eval` or won't parse → **bail (no approve)**; else each segment's leading words must prefix-match some blessed `bash:<phrase>` (or a bare `<tool>` entry matches the tool). Every segment must pass.
4. **decide():** `auto_approve` fires → approve; else `gate` matches → enqueue; else `on_unmatched`.
5. **Schema:** add `on_unmatched: z.enum(["approve","ask"]).default("approve")`; reject descriptors whose bare token isn't a known pi tool (catches `gate: [rm]`).

Pin the tests to the two worked tables in ADR 0004 (trusting + cautious), plus the fail-closed cases (`$(…)`, `$VAR`), `npm test` vs `npm publish`, `git push` phrase, and `alarm-cli` not matching `rm`.

Also: the user-facing docs (`intro.md`, `extensions-with-pid.md`, `v0-spec.md`) were corrected on 2026-06-02 to the *pre-revision* model — they still say "block-list only / don't allow-list" and don't mention `on_unmatched` or phrase-level. Re-touch them after B so they describe the two postures. (Docs-as-spec; do it before or alongside, not after launch.)

That's the whole story. The grammar question was real; following it honestly turned a contradictory spec into a sharper one — two postures, small lists either way, no "approve 65 commands", no "gate 25 args". Go build it.

— past-you
