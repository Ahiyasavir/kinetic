# autopilot/core — the reusable agent-workflow engine

`core/` is the **project-agnostic heart** of the kinetic. It packages the four agent workflows that
drive every improvement cycle — **selector → implementer → reviewer → auditor** — and the
role-invocation runtime that powers them. Nothing in `core/` knows anything about RushPoint (no
Firestore paths, no `apps/` layout, no scoring math, no validation commands, no git). All of that
project-specific glue lives in `supervisor.mjs`, which wires it in once.

This is the structural foundation for running the same engine against **any** project: a host supplies
its own prompts, config, Claude runner, and post-validation, and gets back ready-to-use workflows.

## Module map

```
core/
├── index.mjs            # public entry-point — createCore({...}) + re-exports
├── runtime.mjs          # generic role runner: renderPrompt, extractJsonObject, readHandoff,
│                        #   clearHandoff, createRoleRunner({ promptDir, handoffDir, cwd, config,
│                        #   runClaude, onUsage, log })
├── selector/index.mjs   # runSelector(runner, vars, model)   → reads selection.json
├── implementer/index.mjs# runImplementer(runner, vars, model) → reads implementation.json
├── reviewer/index.mjs   # runReviewer(runner, vars, model)   → reads review.json
└── auditor/index.mjs    # runAuditor(runner, vars, model)    → reads audit.json
```

Each role module does exactly one thing: invoke its named role and return the parsed handoff. The
**ranking/scoring model, file paths, validation commands, and git** are all the host's responsibility —
they are passed in through the prompt `vars` and handled by the host after each workflow returns. That
separation is what makes the engine reusable.

## What is generic vs. project-specific

| Lives in `core/` (generic)                                  | Lives in the host (project-specific)                         |
|-------------------------------------------------------------|--------------------------------------------------------------|
| Prompt template rendering (`{{VAR}}` fill)                  | The prompt **content** (`autopilot/prompts/*.md`)            |
| Role invocation + model resolution (`config.models[name]`) | `config.json` values, the Claude runner (`lib/claude.mjs`)  |
| Handoff JSON parsing / clearing                            | Where handoffs live, what to do with each verdict           |
| The selector→implementer→reviewer→auditor **sequence**     | Task scoring/ranking, validation commands, git, file paths  |

## How a host consumes the framework

```js
import { createCore } from './core/index.mjs';
import { runClaude } from './lib/claude.mjs';

// Wire the host context in ONCE. None of these values are baked into core/.
const core = createCore({
  promptDir,    // where <role>.md templates live
  handoffDir,   // where each role writes its <role>.json result
  cwd,          // working dir for the Claude CLI
  config,       // provides config.models[<role>] and a default config.model
  runClaude,    // ({ prompt, cwd, config, label, model }) => result  (host-provided)
  onUsage,      // (result) => void   — optional token/cost metering hook
  log,          // (...args) => void  — optional logger
});

// High-level workflows: invoke a role and get its parsed handoff back.
const selection = await core.runSelector(selectorVars);
const impl      = await core.runImplementer(implVars, implementerModel);
const review    = await core.runReviewer(reviewVars);
const audit     = await core.runAuditor(auditVars);

// Low-level escape hatches are available too:
//   core.invokeRole(name, vars, model)   core.readHandoff(file)   core.clearHandoff()
```

### Onboarding a different project

Because `core/` hardcodes nothing, a new project needs **no changes here**. It only provides:

1. Its own `prompts/*.md` for each role (same `{{VAR}}` contract).
2. A `config.json` with a `models` map (and project `paths` / `validation` — see
   `../config-loader.mjs`, the non-protected config seam).
3. A `runClaude`-compatible runner and its own post-validation / git glue in a host supervisor.

The same `createCore({...})` call then drives the full cycle for that project unchanged.

## Relationship to the Strangler-Fig guard

`supervisor.mjs` and `watchdog.mjs` are frozen by `lib/protect.mjs` until `core/.ready` exists, so the
new engine could be built here safely before the live entry-points were allowed to consume it. With the
supervisor now importing these workflows from `core/`, that sentinel is present and the freeze is
lifted. The per-file `node --check` syntax gate still guards every `.mjs` under `autopilot/`.
