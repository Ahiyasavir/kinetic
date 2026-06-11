# HARDENING Slice 2b: hint-unlock concurrency — no double-charge on simultaneous hint taps
goal: reliability
risk: 4

PRODUCTION HARDENING. EXTEND the EXISTING per-task hint-unlock Cloud Function (built earlier as the
smart-station "hint economy"; Grep functions/src/index.ts for the hint-unlock callable that writes
`gameState.bonusPenalty` and a `hintsUnlocked[taskId]` flag). It is already meant to be idempotent —
make that bulletproof under concurrency.

Requirements:
- The whole unlock (read the already-unlocked flag → deduct hintCost into bonusPenalty → set the flag →
  return hint text) must run inside ONE `db.runTransaction`.
- The "already unlocked?" check must be RE-READ inside the transaction. If the flag is already set (a
  concurrent tap won), short-circuit and return the hint text WITHOUT deducting points again.
- Net effect: N simultaneous unlock taps for the same team+task deduct the cost exactly ONCE and return
  the hint; the team is never double-charged.

Preserve the normal first-unlock behavior and the existing point cost. gameState/score stay
server-write-only. Acceptance: two near-simultaneous unlock calls for the same team+task deduct the cost
once and both return the hint; re-opening later still returns it free. typecheck + admin build green.
