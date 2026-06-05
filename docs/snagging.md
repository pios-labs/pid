# Snagging list

Small known defects and hardening items to clear **before go-live** — not big enough for an ADR, too real to forget. Newest first. When fixed, note the commit and strike the entry (or delete it on the next pass).

Severity: 🔴 correctness/robustness · 🟡 polish/ergonomics · ⚪ nice-to-have.

---

## Open

*(none)*

---

## Fixed

### ~~S1 🔴 `StateStore.persist()` races on a fixed `.tmp` path~~ — fixed `32a6985`

`src/state/store.ts` `persist()` always writes to `${this.path}.tmp` then `rename()`s it onto `state.json`. Two concurrent `persist()` calls — multiple state-changing ops in flight, or (as in the test suite) two `StateStore` instances sharing one `PID_HOME` — both write the **same** temp file and both rename: the first rename wins and removes the temp, the second hits `ENOENT: rename '…/state.json.tmp' -> '…/state.json'`.

- **Symptom:** intermittent `ENOENT` from `persist()`; surfaces as flaky supervisor/crash tests (observed 2026-06-03 during the log-envelope increment).
- **Why it's real, not just test noise:** the daemon can persist concurrently (e.g. a budget pause and a quarantine landing together), so the same race exists in production — worst case a dropped or torn write of `state.json`.
- **Fix options:** (a) unique temp filename per write (`${path}.${pid}.${counter}.tmp`) so concurrent writers don't collide; **(b) serialize persists through a per-store promise queue** (mirrors the per-service queue in `governor/crash.ts`) — preferred, since it also prevents last-writer-wins clobbering of `state.json`. (a)+(b) together is belt-and-braces.
- **Scope:** small, isolated to `store.ts`.
- **Fix:** shipped **(a)+(b)** in `store.ts` — a per-store serialization queue (chained off `this.queue`, `.catch`-isolated so one failure can't poison later persists but the caller still sees the rejection) plus unique temp names (`${path}.${process.pid}.${++tmpCounter}.tmp`). (b) serializes within a store; (a) covers the cross-instance/cross-process case the per-store queue can't. Two regression tests in `supervisor.test.ts` ("snag S1") — both **fail against the pre-fix code** (ENOENT *and* a torn/corrupt `state.json` write), confirming the production risk was real, not just test noise.
