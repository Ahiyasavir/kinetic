reliability: pre-implementation planning gate — Selector writes a locked intent.md anchor, Implementer writes a Haiku-validated micro-plan before coding starts; prevents scope drift and revision loops
goal: reliability
risk: 3
effort: 3

## Background & Motivation

The primary failure pattern in this engine is scope drift: after 2-3 failed revision attempts the
model stops solving the original task and starts patching its own broken implementation. U-57 needed
3 revisions + rollback exactly because the intent was never locked and the reviewer had no anchor to
check against. This task adds two lightweight guards that fire BEFORE the Implementer touches a
single file.

---

## Deliverable 1 — Intent Anchor (intent.md)

Written by the Selector at end of its run (added to the selector prompt). Saved to
`autopilot/state/handoff/intent-{taskId}.md`. Contains exactly 3 locked fields:

```
## must
- <bullet: what must exist or work when the task is done — max 5>

## mustNot
- <bullet: files or modules NOT to touch — max 3>

## successSignal
One sentence: how a human verifies this task is done in 30 seconds.
```

Rules:
- NEVER modified by Implementer, Reviewer, or Auditor — it is read-only after Selector writes it.
- Reviewer reads it as the FIRST step of review. Review starts with: "Does the diff satisfy ALL
  `must` items and violate NONE of the `mustNot` items?" If no → block with which item is missing.
- When a task goes into revision, the Implementer receives intent.md before the revision prompt so
  it doesn't "fix its own error" but re-addresses the original goal.

---

## Deliverable 2 — Micro-Plan (plan.md)

Fires only for tasks where task.risk >= config.planningGate.minRisk (default: 3).

Flow:
1. Implementer receives the task + intent.md and writes a 5-7 bullet plan to
   `autopilot/state/handoff/plan-{taskId}.md` BEFORE writing any code.
   Each bullet = one file + one action (e.g. "lib/planner.mjs — create and export runPlanner()").
2. A cheap Haiku validation call checks the plan against intent.md:
   - Input: intent.md + plan.md
   - Output: { verdict: "APPROVE" | "REJECT", reason: string (1 sentence) }
   - If APPROVE: proceed to full implementation.
   - If REJECT: Implementer revises the plan once, then re-validates. If still rejected: proceed
     anyway (do not block; log the rejection reason to handoff for reviewer context).
3. For tasks with risk < minRisk: skip plan step entirely — it adds overhead without value.

---

## Deliverable 3 — lib/planner.mjs

New module. Exports:
```js
export async function runPlanner(task, handoffDir, config, invoker) {
  // 1. Write intent.md from selector output (call from Selector phase)
  // 2. If task.risk >= config.planningGate.minRisk: write plan.md + validate with Haiku
  // Returns: { intentPath, planPath, planApproved }
}
```

Wire into supervisor.mjs AFTER Selector.run() completes and BEFORE Implementer.run() starts.
Store result in handoff. Must be a no-op (return early) when config.planningGate.enabled is false.

---

## Config Scaffold

Add to autopilot/config.json:
```json
"planningGate": {
  "enabled": true,
  "minRisk": 3,
  "_comment": "U-81 planning gate — Selector writes intent anchor, Implementer validates micro-plan before coding"
}
```

---

## Acceptance Criteria

1. `autopilot/lib/planner.mjs` exists and exports `runPlanner(task, handoffDir, config, invoker)`.
2. After Selector completes, `autopilot/state/handoff/intent-{taskId}.md` exists with `must`,
   `mustNot`, and `successSignal` sections.
3. For risk>=3 tasks: `plan-{taskId}.md` is written and the Haiku validation call is logged.
4. Reviewer prompt template includes "Read intent.md first. Block if any `must` item is absent."
5. Config flag `planningGate.enabled: false` skips the phase entirely — a full cycle still completes.
6. `lib/planner.mjs` is imported by `supervisor.mjs` (not a dead file).
7. Static marker present in lib/planner.mjs: `// planning gate: intent anchor written`

## Implementation Rules (MANDATORY — read before starting)

- This is an ENGINE task (class: engine). Deliverables live in autopilot/ (gitignored).
  Do NOT create files in src/, apps/, functions/, or any tracked directory.
- Use node:test for tests (NOT Jest). Import: `import { test } from 'node:test'; import assert from 'node:assert'`
- lib/planner.mjs MUST be imported by supervisor.mjs or it fails the dead-file check.
- supervisor.mjs IS editable (autopilot/core/.ready exists).
- Any verifyArtifact.contains value must be a static string literal — never a template literal.
- Wire location in supervisor.mjs: AFTER runSelector(), BEFORE runImplementer().
