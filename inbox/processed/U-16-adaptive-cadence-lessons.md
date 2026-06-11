U-16: Adaptive Cadence, Failure Learning Loop & Deep Refinement
goal: reliability
risk: 3
effort: 4

## Background

The kinetic now has risk-aware routing and a fixed weekly cadence governor (maxCyclesPerDay).
What is missing is a feedback loop: the system does not adapt its pace to actual consumption
velocity, and it does not learn from its own revision history to prevent recurring failures.

Implement two complementary self-improvement mechanisms — adaptive budgeting and a lessons-learned
memory core — while strictly preserving the existing review/audit pipeline unchanged.

---

## 1 — Dynamic Cadence Tuning (Adaptive Budgeting)

The weekly budget governor in `paceForWeeklyBudget()` (supervisor.mjs) currently uses a fixed
`config.weeklyBudget.maxCyclesPerDay`. Replace this with a **Velocity Factor** calculation:

```
velocityFactor = (fractionBudgetUsed) / (fractionWeekElapsed)
```

- `fractionBudgetUsed`  = state.usage.cycles / (maxCyclesPerDay * resetIntervalDays)
- `fractionWeekElapsed` = (now - windowStartedAt) / (resetAt - windowStartedAt)
- clamp velocityFactor to [0.1, 2.0]; default to 1.0 when data is insufficient

Behavior:
- velocityFactor > 1.0  → burning faster than time allows → scale DOWN effective maxCyclesPerDay
  by dividing by velocityFactor (floor at 4 cycles/day minimum)
- velocityFactor <= 1.0 → on or under budget → use configured maxCyclesPerDay as-is

Add `config.weeklyBudget.velocitySensitivity` (default 1.0) as a tuning multiplier applied to the
factor before clamping. Store `state.usage.velocityFactor` (latest computed value) in state so
`status` can display it.

Write **mock simulation tests** (plain node assertions, no framework) inside
`autopilot/tests/budget-velocity.mjs` covering:
- stable consumption (factor ≈ 1.0 → no throttle)
- over-budget (factor 1.6 → effective rate drops)
- under-budget (factor 0.4 → full rate kept)
- window rollover edge case (windowStartedAt == resetAt)

---

## 2 — Lessons-Learned Memory Core (lessons.json)

Create `autopilot/state/lessons.json` (gitignored, safe from git reset --hard).

### Schema (array of entries):
```json
[
  {
    "id": "L-001",
    "ts": "2026-06-05T...",
    "taskId": "T-0062",
    "title": "network error resilience for mobile callables",
    "keywords": ["callable", "retry", "network", "mobile"],
    "failureType": "revision_loop",   // "revision_loop" | "crash" | "rollback" | "validation_fail"
    "revisionCount": 3,
    "filesInvolved": ["apps/mobile/src/services/firebase.ts"],
    "errorSummary": "reviewer rejected for missing idempotency guard",
    "avoidHints": "Always add idempotency guard; check for double-call race."
  }
]
```

### Capture (when to write a lesson):
A lesson is written when **any** of these hold at the end of a cycle:
- `revisionCount >= 3`
- outcome is `rollback` or `crash`
- `state.current.status === 'blocked'`

Extract `keywords` by splitting the task title + notes on whitespace/punctuation, lowercasing,
removing stop-words (the, a, an, for, to, of, and, or, in, on, at, is, are, with, that, this,
from, by), and keeping words of length >= 4. Deduplicate. Keep max 20.

### Pre-flight matching (before launching a cycle):
After the selector picks a task, compute **Jaccard similarity** between the candidate's keywords
and every lesson's keywords:

```
jaccard(A, B) = |A ∩ B| / |A ∪ B|
```

If any lesson scores >= 0.6:
1. **Risk escalation**: increment `task.risk` by +1 (cap at 5).
2. **Context injection**: append to the implementer prompt:

```
[SYSTEM WARNING: Past Failure Context]
A similar task ("${lesson.title}") previously required ${lesson.revisionCount} revision(s).
Failure type: ${lesson.failureType}.
Files involved: ${lesson.filesInvolved.join(', ')}.
What went wrong: ${lesson.errorSummary}.
What to avoid: ${lesson.avoidHints}.
```

Log the match and escalation so it is visible in run.log.

### Graceful degradation:
If lessons.json is missing, empty, or fails to parse: catch the error, log a warning, reset to
`[]`, and continue. Never crash the loop over a bad lessons file.

### Tests:
Write `autopilot/tests/lessons-learning.mjs` (plain node assertions) that:
- Creates a mock state with a high-revision cycle, verifies a lesson entry is generated
- Loads two lessons and runs Jaccard matching against a candidate, verifies escalation triggers at >= 0.6
- Verifies graceful degradation on a corrupted `lessons.json`

---

## 3 — Status Telemetry Integration

Extend `cmdStatus()` in supervisor.mjs to show:
```
weekly budget: N cyc · $X.XX · Yk tok · Velocity: 1.2x (Throttled) · resets in Z.Zd
lessons: M stored  [warn if any match would trigger for the current backlog top-3]
```

---

## Strict Guardrails

- Do NOT modify the `invokeRole` → `runCycle` → review/audit/validate pipeline flow in any way.
- All new files live under `autopilot/` (gitignored, safe).
- Lessons and velocity state live in `state.usage.velocityFactor` and `autopilot/state/lessons.json`.
- lib/score.mjs and lib/route.mjs must remain unmodified (routing was just tuned).
- The `lessons.json` failure mode must always degrade gracefully; a corrupt file must NEVER crash the loop.

---

## Definition of Done

- [ ] `node --check autopilot/supervisor.mjs` passes with zero syntax errors.
- [ ] `node autopilot/tests/budget-velocity.mjs` runs and all assertions pass.
- [ ] `node autopilot/tests/lessons-learning.mjs` runs and all assertions pass.
- [ ] After a simulated high-revision cycle, `state/lessons.json` contains a valid entry.
- [ ] A subsequent task with Jaccard >= 0.6 shows risk escalation in run.log and enriched prompt.
- [ ] `node autopilot/supervisor.mjs status` displays velocity factor and lesson count.
