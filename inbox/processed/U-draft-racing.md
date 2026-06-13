optimization: parallel draft racing — run 2 Haiku drafts concurrently with divergent system prompts (aggressive vs conservative), Sonnet selects the best candidate before Implementer refines; reduces revision loops without increasing cost
goal: optimization
risk: 3
effort: 3

## Background & Motivation

The current single-pass Sonnet implementation fails on ~30% of tasks and enters revision loops
that cost 2-3× more than the initial run. The core problem: a single prompt either succeeds or
fails with no diversity signal. Draft racing generates two cheaply-divergent attempts in parallel,
then a short Sonnet selection call picks the winner. Math: 2×Haiku + 1×short-Sonnet ≈ 0.7× the
cost of 1 full Sonnet. Break-even is revision rate > 25% — we are well above that.

IMPORTANT: This task depends on U-81 (planning gate / intent anchor). The draft racing Sonnet
selector MUST use intent.md as its evaluation rubric. If U-81 is not yet shipped, fall back to
using the task's acceptanceCriteria as the rubric.

---

## Two Divergent Drafts

Both use `claude-haiku-4-5`. Both receive the same task context + intent.md anchor. They differ
only in their system-prompt prefix (2-3 sentences):

Draft A — "aggressive":
> "You are a direct, fast implementer. Prefer the shortest correct solution. Minimize boilerplate
> and defensive code. Ship the working core, skip edge cases that aren't in the requirements."

Draft B — "conservative":
> "You are a careful, defensive implementer. Prefer explicit error handling and readable code over
> brevity. Validate inputs at boundaries. Add a one-line comment per non-obvious decision."

Run BOTH with Promise.all for true parallel execution. Neither blocks on the other.

---

## Sonnet Selector

After both drafts complete, a SHORT Sonnet call (not a full implementation call — just a selection
prompt, ~200 output tokens) receives:
- intent.md (or acceptanceCriteria if intent.md absent)
- Draft A's output + its token count
- Draft B's output + its token count

Output schema (JSON):
```json
{ "winner": "A" | "B", "reason": "<1 sentence>", "needsRefinement": true | false }
```

If needsRefinement = false → pass winner directly to Reviewer.
If needsRefinement = true  → pass winner to Implementer with prompt: "Refine this draft to fully
satisfy the missing items. Do not rewrite from scratch." (cheaper than a full implementation).

---

## Fallback Rules

- If one draft fails (rate limit, timeout, error): use the surviving draft as sole input. Never
  block a cycle because one of the two parallel calls failed.
- If BOTH drafts fail: fall through to the standard Implementer run (current behavior). Never
  fail the cycle due to draft racing infrastructure.
- If needsRefinement = true but Implementer is rate-limited: skip refinement, send winner to
  Reviewer directly with a note in handoff.

---

## lib/draft-racer.mjs

New module. Exports:
```js
export async function runDraftRacing(task, handoffDir, config, invoker) {
  // Returns: { winner: 'A'|'B', draft: string, needsRefinement: boolean, skipped: boolean }
  // skipped: true when config.draftRacing.enabled is false or task.risk < minRisk
}
```

Wire into supervisor.mjs AFTER planningGate (U-81) completes and BEFORE Implementer.run().
When skipped=true, Implementer runs as normal (no behavior change).

---

## Config Scaffold

Add to autopilot/config.json:
```json
"draftRacing": {
  "enabled": false,
  "minRisk": 2,
  "refinementModel": "claude-sonnet-4-6",
  "_comment": "U-82 draft racing — disabled by default, enable to reduce revision loops via parallel Haiku drafts"
}
```

Disabled by default — user opts in. Reason: introduces parallel API calls which increase
rate-limit surface area. Recommend enabling only after confirming U-81 is working.

---

## Acceptance Criteria

1. `autopilot/lib/draft-racer.mjs` exists and exports `runDraftRacing(task, handoffDir, config, invoker)`.
2. When enabled and task.risk >= minRisk: two Haiku calls fire simultaneously (Promise.all).
3. Sonnet selector call receives both draft outputs and returns winner JSON.
4. One-draft failure falls back gracefully to the surviving draft (logged to handoff).
5. Both-drafts failure falls through to standard Implementer (no cycle failure).
6. Config `draftRacing.enabled: false` is the default and results in zero behavior change.
7. `lib/draft-racer.mjs` is imported by `supervisor.mjs` (not a dead file).
8. Static marker present in lib/draft-racer.mjs: `// draft racing: parallel haiku candidates`

## Implementation Rules (MANDATORY — read before starting)

- This is an ENGINE task (class: engine). All files go under autopilot/ (gitignored).
- Use node:test for tests (NOT Jest).
- lib/draft-racer.mjs MUST be imported by supervisor.mjs or it fails the dead-file check.
- supervisor.mjs IS editable (autopilot/core/.ready exists).
- Any verifyArtifact.contains must be a static string literal, never a template literal.
- Wire location: AFTER planningGate phase, BEFORE runImplementer().
