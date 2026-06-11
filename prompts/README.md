# autopilot/prompts/

AI role prompt templates for the kinetic loop, isolated from the engine code. Each role the
supervisor runs (`invokeRole(name, …)` in `supervisor.mjs`) loads its prompt from `<name>.md` here
via `renderPrompt()`, which substitutes `{{VARIABLE}}` tokens with values the supervisor injects at
call time. Keep prompt prose in these files — not hardcoded in the workflow modules — so the wording
can evolve without editing engine code.

## Templates

| File | Role | Model | Purpose |
|---|---|---|---|
| `selector.md` | selector | Opus | Pick the single highest-value task for the cycle; emit `selection.json`. |
| `implementer.md` | implementer | routed (Sonnet/Opus) | Implement exactly that task on the integration branch; emit `implementation.json`. |
| `reviewer.md` | reviewer | Opus | Adversarial first-gate review of the diff; emit `review.json`. |
| `auditor.md` | auditor | Opus | Independent second-gate regression/scope audit; emit `audit.json`. |

## Injected variables (`{{VAR}}`)

The supervisor fills these per role — preserve every token a template uses, and do **not** introduce
a `{{VAR}}` the supervisor does not pass (it would render literally):

- **selector** — `CANDIDATES`, `WEAK_BACKLOG`, `DONE`, `BLOCKED`, `NEXT_ID`, `HANDOFF_PATH`
- **implementer** — `TASK_JSON`, `CYCLE_BRANCH`, `REVISION_BLOCK`, `HANDOFF_PATH`
- **reviewer** — `TASK_JSON`, `IMPL_REPORT`, `VALIDATION`, `INTEGRATION_BRANCH`, `HANDOFF_PATH`
- **auditor** — `TASK_JSON`, `IMPL_REPORT`, `VALIDATION`, `INTEGRATION_BRANCH`, `HANDOFF_PATH`

## Conventions

- **No brand jargon.** Refer to the application generically ("the target application", "the target
  monorepo", "the product") rather than by event/brand name, so the engine is reusable across
  projects. Real, functional references stay (package names like `@rushpoint/shared`, repo files
  like `CLAUDE.md`/`INSTRUCTIONS.md`, and concrete shipped-feature lists that prevent rebuilds).
- **Preserve the output JSON schema** in each template exactly — the supervisor parses the handoff
  files those schemas describe.
- Editing `reviewer.md`/`auditor.md` affects the gates that judge the *current* cycle (the supervisor
  reads them at invoke time), so change their verdict logic carefully.
