# HARDENING Slice 2a: submitStationCode concurrency — no double-complete / double-streak on simultaneous taps
goal: reliability
risk: 4

PRODUCTION HARDENING. EXTEND the EXISTING backend — `submitStationCode` (functions/src/index.ts ~2923)
and the `completeSmartStation` helper (~2818) which ALREADY uses `db.runTransaction`. Do NOT rewrite the
scoring; make the completion idempotent under concurrency. Two devices on the SAME team may tap "Verify"
within the same millisecond.

Requirements:
- Ensure the slot-completion + score-award + speed-streak update all happen INSIDE a single
  `runTransaction`, and that the active slot's state is RE-READ inside the transaction (not from a stale
  pre-read).
- Inside the transaction, if the target slot is ALREADY `completed` (a concurrent tap won the race),
  SHORT-CIRCUIT: return a cached success (e.g. `{ correct: true, completed: true, alreadyDone: true }`)
  WITHOUT awarding the task score again and WITHOUT incrementing the speed-streak/activeCombo again.
- Net effect: N simultaneous valid submissions complete the slot exactly ONCE — score added once, streak
  incremented once. Single-submission behavior is unchanged.

Preserve all existing behavior for the normal (single, first) submission. gameState/score stay
server-write-only. Acceptance: two near-simultaneous valid submitStationCode calls for the same team+slot
result in exactly one score award and one streak increment (verify by reasoning/e2e); a single call works
exactly as today. typecheck + admin build green.
