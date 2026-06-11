ARCH-BLUEPRINT: Decouple the engine from the project (generic autonomous-agent core)
goal: structure
risk: 4
effort: 5

> ## 🛑 SELECTOR DIRECTIVE — READ BEFORE SELECTING (MANDATORY)
> **DO NOT implement this document in one cycle. DO NOT treat it as a single task.**
> This is a NORTH-STAR architecture spec. On any cycle where this blueprint is the top candidate you
> MUST instead **carve out exactly ONE small, independently-reviewable, non-breaking sub-task** (a
> single file move behind a shim, one config key, one interface stub) and implement ONLY that. A
> sub-task must be shippable in a single cycle and pass review on its own. If you cannot express the
> next step as one ≤~150-line, single-concern diff, pick a smaller step. Swallowing multiple sections
> at once = automatic rejection.
>
> **Enforced guardrails now active (you cannot bypass these):**
> - `supervisor.mjs` and `watchdog.mjs` are **FROZEN** — any edit/deletion is auto-reverted and fails
>   validation until `autopilot/core/.ready` exists. Build the new engine under `autopilot/core/` and
>   only flip the thin shim in the final phase.
> - Every `autopilot/**/*.mjs` is `node --check`-gated each cycle — a syntax error fails the cycle.
> - All new assets stay under `autopilot/` (gitignored, survive `git reset --hard`).
>
> Each cycle must ship ONE small, reviewable, non-breaking step. The running supervisor loop MUST keep
> working after every step. When unsure how to slice, prefer the smallest change that leaves
> `node autopilot/supervisor.mjs status` and a full cycle working.

---

## 0. Objective & Guiding Principles

Transform the RushPoint-specific kinetic into a **project-agnostic autonomous-agent engine** that
can drive *any* target workspace, while RushPoint becomes just one "project context" plugged into it.

**Invariants (never violate):**
1. **Non-breaking:** after every committed step the live loop still selects → implements → reviews →
   audits → validates → merges. No step may leave the supervisor unrunnable.
2. **Engine knows nothing about RushPoint.** All RushPoint facts (paths, goals, phases, domain
   knowledge, validation commands, seed backlog) live in a swappable *context*, never in `core/`.
3. **Everything stays under `autopilot/`** so it remains gitignored and survives `git reset --hard`
   (the cycle reset only touches tracked project files; `-e kinetic` excludes the engine).
4. **No secrets in context files.** The pinned account (`autopilot/.account/`) stays separate and is
   never read by the context layer.
5. **The dual-stage quality gate (revise → approve → audit) is sacred** — refactors may MOVE it into
   `core/` but must not change its control flow or weaken it.

---

## 1. Generic `kinetic.config.json` (Config Isolation)

Today `autopilot/config.json` mixes engine tuning with RushPoint specifics. Split it into:
**(a) engine config** (model endpoints, cadence, routing thresholds — project-neutral) and
**(b) a project profile** (paths, goals, phases, validation, domain knowledge pointer).

Target top-level schema:

```jsonc
{
  "engine": {
    "models": { "selector": "...", "reviewer": "...", "auditor": "...",
                "implementerHigh": "...", "implementerLow": "..." },
    "implementerRouting": { "opusMinRisk": 3, "opusKeywords": ["..."] },
    "cli": { "bin": "claude", "outputFormat": "json", "permission": "--dangerously-skip-permissions",
             "timeoutMs": 1800000, "maxTurnsPerCall": 60 },
    "cycle": { "maxReviseAttempts": 2, "cooldownBetweenCyclesMs": 120000, "backlogTopUpThreshold": 4 },
    "rateLimit": { "baseCooldownMs": 1200000, "maxCooldownMs": 2700000 },
    "weeklyBudget": { "enabled": true, "resetAt": "...", "maxCyclesPerDay": 30, "velocitySensitivity": 1.0 },
    "learning": { "enabled": true, "jaccardThreshold": 0.6, "revisionFailureThreshold": 3 }
  },

  "project": {
    "id": "rushpoint",
    "workspaceRoot": ".",                         // path target — the repo the agent edits
    "git": { "integrationBranch": "autopilot/topo", "baseBranch": "topographic-maps", "commitPrefix": "kinetic" },
    "validation": {                               // VALIDATION HOOKS = dynamic string arrays
      "commands": [
        { "name": "typecheck",   "cmd": "npm run typecheck",                 "required": true,  "timeoutMs": 600000 },
        { "name": "build-admin", "cmd": "npm run build --workspace=apps/admin","required": true, "timeoutMs": 600000 },
        { "name": "lint",        "cmd": "npm run lint",                       "required": false, "timeoutMs": 600000 }
      ],
      "lintRegressionGuard": true,
      "e2e": { "enabled": false, "cmd": "node scripts/e2e-verify.mjs", "timeoutMs": 600000 }
    },
    "goals":  ["structure","features","ui","social","admin","continuous"],   // was GOAL_PHASES
    "phase":  "hardening",
    "scoring": { "weights": { "...": 0 }, "categoryBonus": { "...": 0 },
                 "minProductShare": 0.7, "minProductTasks": 5, "maxAttemptsBeforeBlock": 3 },
    "context": { "provider": "fs", "domainKnowledgeDir": "contexts/rushpoint" }  // see §3
  }
}
```

**Requirements**
- Maintain **backward compatibility** during migration: a small `loadConfig()` shim in `core/` reads
  the new shape but ALSO accepts today's flat keys (map `models`→`engine.models`, etc.) so a half-migrated
  config never crashes the loop. Emit a one-line deprecation warning when reading legacy keys.
- Validate the loaded config against a JSON Schema (`core/config.schema.json`); on a missing/invalid
  field, log a clear error and fall back to a documented default rather than throwing.
- The engine reads ONLY `config.engine.*` + the **ContextProvider** (§3); it must never `require` a
  RushPoint path directly.

**Acceptance:** `node autopilot/supervisor.mjs status` works with the new config; deleting any
`project.*` key yields a clear validation error (not a stack trace); engine code contains zero literal
RushPoint strings.

---

## 2. Engine Isolation — `autopilot/core/` Folder Structure

Separate **reusable engine logic** from **project context**. Move (don't fork) today's `lib/*` into a
namespaced `core/` and leave behind thin re-export shims during migration so imports don't break.

```
autopilot/
├── core/                       # PROJECT-AGNOSTIC ENGINE (no RushPoint knowledge)
│   ├── loop.mjs                # the cycle state-machine (extracted from supervisor.mjs runCycle/main)
│   ├── orchestrator.mjs        # role sequencing: select → implement → review → audit → validate → merge
│   ├── agents/
│   │   ├── cli.mjs             # ← lib/claude.mjs (CLI runner, RateLimitError, account pinning)
│   │   ├── selector.mjs        # selector role wrapper + prompt assembly
│   │   ├── implementer.mjs     # implementer role wrapper + context/lessons injection
│   │   ├── reviewer.mjs        # reviewer role  (quality gate — DO NOT alter flow)
│   │   └── auditor.mjs         # auditor role   (quality gate — DO NOT alter flow)
│   ├── routing.mjs             # ← lib/route.mjs (risk-aware model routing)
│   ├── scoring.mjs             # ← lib/score.mjs (rank/score/isCleanup/Jaccard)
│   ├── learning.mjs            # ← lib/learn.mjs (lessons.json capture + pre-flight match)
│   ├── budget.mjs              # weekly cadence + velocity governor (extracted from supervisor.mjs)
│   ├── git.mjs                 # ← lib/git.mjs (worktree-safe git ops)
│   ├── validate.mjs            # ← lib/validate.mjs (runs config.project.validation.commands)
│   ├── persistence.mjs         # ← lib/state.mjs load/save/atomic/recover (schema-driven, see §4)
│   ├── queues.mjs              # universal task pipeline state-machine (see §4)
│   ├── config.mjs              # loadConfig() + schema validation + legacy shim (§1)
│   └── context.mjs             # ContextProvider interface + factory (§3)
│
├── contexts/                   # PROJECT CONTEXTS (swappable)
│   └── rushpoint/
│       ├── profile.json        # goals, phases, scoring, seed backlog metadata
│       ├── seed-backlog.json   # ← seedBacklog() data, now declarative JSON not code
│       ├── domain.md           # RushPoint facts the prompts need (paths, stack, "already shipped")
│       └── prompts/            # project-flavored overrides, layered over core/prompts base
│           ├── selector.md  implementer.md  reviewer.md  auditor.md
│
├── prompts/                    # GENERIC base prompts (role behavior, no project facts)
├── supervisor.mjs              # THIN CLI shim → delegates to core/loop.mjs + core/cli commands
├── watchdog.mjs                # unchanged (forever-run wrapper)
├── state/                      # gitignored runtime (state.json, lessons.json, run.log, handoff/…)
├── inbox/                      # unchanged ingestion drop-zone
└── .account/                   # pinned credentials (engine reads via cli.mjs only)
```

**Requirements**
- Migrate **one module per cycle** using re-export shims: e.g. cycle 1 creates `core/routing.mjs` and
  rewrites `lib/route.mjs` to `export * from '../core/routing.mjs'`. Existing imports keep working;
  later cycles flip call-sites to the `core/` path; the shim is deleted last.
- `supervisor.mjs` shrinks to argv parsing + command dispatch that calls into `core/`. All loop logic
  lives in `core/loop.mjs`.
- Prompts become **layered**: `core/prompts/<role>.md` (generic role contract) + `contexts/<id>/prompts/<role>.md`
  (project facts) concatenated at assembly time. No project string in `core/prompts`.

**Acceptance:** every module under `core/` passes `node --check`; grepping `core/` for `rushpoint`,
`topographic`, `apps/`, `functions/` returns ZERO hits; a full cycle still runs end-to-end.

---

## 3. Context Provider Interface (Agnostic Workspace Mapping)

Define an interface that maps ANY target workspace and feeds it safely into the agents (esp. the
Selector and Implementer). The engine depends on this interface, never on a concrete project.

```js
// core/context.mjs
/**
 * @typedef {Object} ContextProvider
 * @property {() => string}                 workspaceRoot   Absolute path the agent may edit.
 * @property {() => ProjectProfile}         profile         { id, goals[], phase, scoring }.
 * @property {() => Task[]}                  seedBacklog     Declarative starter tasks (may be []).
 * @property {() => ValidationCommand[]}     validation      Dynamic test/lint/build command array.
 * @property {() => GitTargets}             gitTargets      { integrationBranch, baseBranch, commitPrefix }.
 * @property {(role:string) => string}      promptLayer     Project prompt overlay for a given role.
 * @property {() => string}                 domainKnowledge Markdown facts injected into prompts.
 * @property {(text:string) => string}      redactSecrets   Strip anything sensitive before it reaches a model.
 */

export function createContextProvider(config) {
  // factory selects by config.project.context.provider ("fs" | future: "git", "remote")
  // "fs" provider reads contexts/<id>/{profile.json, seed-backlog.json, domain.md, prompts/*}
}
```

**Rules**
- The Selector prompt is assembled as: `core/prompts/selector.md` + `provider.domainKnowledge()` +
  `provider.profile()` summary + the live backlog. The engine passes the provider's outputs through —
  it never hard-codes domain facts.
- `redactSecrets()` runs over every string that leaves for a model (defense-in-depth; never leak
  `.env`, tokens, credentials). Default impl strips `sk-…`, `*_SECRET`, `*_KEY`, `.credentials.json`.
- A **NullContext** (empty goals, no seed, validation = `[{name:"noop"}]`) must let the engine boot
  against an arbitrary empty directory without crashing — proves true decoupling.
- Provider loading is **fault-tolerant**: a missing `domain.md` → empty string; a malformed
  `profile.json` → logged warning + documented defaults; never throw inside the loop.

**Acceptance:** pointing `config.project.context.domainKnowledgeDir` at a second, fake context
(`contexts/_example/`) makes the Selector produce tasks about THAT project, with no code change to
`core/`.

---

## 4. Universal Task-Ingestion Queues (Pipeline State Machine)

Generalize today's queues (`state.json.queues.{backlog,done,blocked}` + `inbox/`) into an explicit,
project-agnostic state machine that can run concurrently against any directory lock.

**Queues & directories**
- `inbox/`        — user drop-zone (files). Ingested at the start of every cycle, then archived to
                    `inbox/processed/`. Ingested exactly once.
- `backlog`       — ranked candidates (in `state.json`). Source of the next task.
- `suggestions`   — NEW: engine/selector-proposed tasks awaiting promotion (kept separate from
                    user backlog so auto-generated ideas can be reviewed/capped, not silently run).
- `done`          — merged successfully.
- `blocked`       — failed after `maxAttemptsBeforeBlock`, with a human-readable reason.

**Canonical task lifecycle (statuses):**
```
ingested ──▶ backlog ──▶ selected ──▶ in_progress ──▶ in_review ──▶ {merged | revise | rejected}
                ▲                                          │
   suggestions ─┘                 revise (≤maxReviseAttempts) ─┘
                                          │ (attempts exhausted)
                                          ▼
                                       blocked  (reason recorded)
```

**Transition rules (must be encoded in `core/queues.mjs`):**
1. **User-first:** any `source:"inbox"` (userRequested) task outranks all auto tasks; never dropped —
   on failure it is re-queued or blocked WITH a reason, never lost.
2. **Idempotent ingestion:** dedupe by id AND near-duplicate title (reuse existing `titlesNearDuplicate`)
   across `backlog ∪ done ∪ blocked ∪ suggestions` before admitting a new task.
3. **Suggestions cap:** auto-proposed tasks land in `suggestions`; only the top-N (config) are promoted
   to `backlog` per cycle, so the queue can't balloon.
4. **Exactly-once + crash-safe:** a task in `in_progress`/`in_review` at startup is recovered (rolled
   back to its snapshot SHA and re-queued) — reuse the current `recover()` logic.
5. **Concurrency / directory lock:** the pipeline operates only while holding the supervisor lock
   (`state/supervisor.lock`, pid-liveness checked). The design must allow a FUTURE second engine
   instance to drive a DIFFERENT `workspaceRoot` concurrently — so all paths are derived from
   `provider.workspaceRoot()` and the lock file lives under that instance's own `state/`, never a
   global. No engine code may assume a single global repo.

**Persistence:** `state.json` schema becomes versioned & provider-tagged:
`{ version, projectId, queues:{ inbox?, backlog, suggestions, done, blocked }, current, usage, stats, history }`.
`persistence.mjs` migrates older `version` shapes forward on load (and keeps writing `state.json.bak`).

**Acceptance:** a simulated run with a queued user task + an auto suggestion shows the user task built
first; suggestions respect the cap; killing the process mid-`in_progress` and restarting recovers the
task to `backlog` with no duplicate and no lost work.

---

## 5. Phased Migration Plan (how the agent should slice this)

Each phase = several small cycles. Do not advance a phase until the loop is verified green.

- **P1 Config split** — add `core/config.mjs` (loader + schema + legacy shim). No behavior change.
- **P2 Engine namespacing** — create `core/` and move modules one-per-cycle behind re-export shims.
- **P3 Context provider** — add `core/context.mjs` + `contexts/rushpoint/`; route domain facts through it.
- **P4 Queues state-machine** — add `core/queues.mjs` + `suggestions` queue + versioned persistence.
- **P5 Prove decoupling** — boot the engine against `contexts/_example/` (NullContext) with no `core/` edits.
- **P6 Cleanup** — delete shims, flip all call-sites to `core/`, update `supervisor.mjs` to a thin shim.

---

## Definition of Done (whole blueprint)

- [ ] `grep -ri "rushpoint\|topographic\|apps/\|functions/" autopilot/core` returns nothing.
- [ ] `node autopilot/supervisor.mjs status` and a full select→merge cycle work after every phase.
- [ ] Swapping `config.project.context` to a second context changes the Selector's output with zero `core/` edits.
- [ ] All new assets live under `autopilot/` (gitignored); a `git reset --hard` during a cycle never deletes them.
- [ ] The revise→approve→audit quality gate is byte-for-byte equivalent in behavior (moved, not modified).
- [ ] `state.json` round-trips through the versioned schema with a `.bak` written each save.
