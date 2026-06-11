# RushPoint Kinetic — 5-Day Autonomous Improvement System

An **external supervisor** that drives Claude Opus 4.8 in repeated work cycles to continuously
improve RushPoint for five days, without waiting for human approval between steps. It behaves like a
product + engineering lead: it inspects the repo, decides the single most valuable next task, has one
Claude agent implement it, has a second Claude agent review it, validates the result, records its
reasoning, and moves on — pausing safely on rate limits and resuming from disk after any restart.

> Smallest design that reliably runs for 5 days. No services, no DB — just Node + the `claude` CLI +
> a few shared files. The **integration branch only ever advances through reviewed + validated work**,
> so existing behavior is preserved by construction.

---

## 1. How it works (supervisor design)

The supervisor (`supervisor.mjs`) is a deterministic loop. **Claude does the thinking; the supervisor
does the bookkeeping, git safety, validation, and rate-limit/restart survival.** One *cycle* =

```
 ┌─ inspect repo state (state.json)
 │
 ├─ 1. SELECT   → claude (selector role)     → writes handoff/selection.json
 │                  picks the #1 task by impact / risk / dependency / goal-phase,
 │                  downgrades risky tasks into a smaller safe subtask, never repeats done work,
 │                  tops up the backlog when it runs low.
 │
 ├─ create per-cycle branch  kinetic/cycle-N  (off the integration branch)
 │
 ├─ 2. IMPLEMENT → claude (implementer role)  → edits + commits on the cycle branch
 │        ↑                                       writes handoff/implementation.json
 │        │
 │   3. VALIDATE  → npm run typecheck / lint (+ optional e2e)   [deterministic]
 │        │
 │   4. REVIEW    → claude (reviewer role)     → writes handoff/review.json
 │        │            approve | revise | reject  (a different agent than the implementer)
 │        └──── revise → loop back to IMPLEMENT (bounded: cycle.maxReviseAttempts)
 │
 ├─ 5. FINALIZE
 │       approve + validation green → merge cycle branch into integration → task → done.md
 │       reject / out of attempts   → discard cycle branch (integration untouched) → blocked.md
 │
 ├─ 6. write decision_log.md entry (what was chosen and why, outcome)
 └─ persist state.json + regenerate backlog.md / done.md / blocked.md, then next cycle
```

If a Claude call hits a usage/rate limit at any point, the supervisor **discards the in-flight cycle
branch, re-queues the task, records a pause, sleeps until the cooldown elapses, then resumes** — no
half-finished work ever reaches the integration branch.

### Roles (the review loop)
- **Selector** and **Reviewer** are intentionally *separate Claude invocations* from the
  **Implementer**. The reviewer sees only the task spec + the diff + validation results and judges the
  work adversarially. Implement-and-self-approve is not possible.

---

## 2. Bundle structure (template distribution)

The autopilot directory is split into four layers. The boundary between them lets the core engine
and reusable plugins be distributed or open-sourced independently of any commercial deployment:

```
autopilot/
│
├── core/                ← PROJECT-AGNOSTIC ENGINE (open-sourceable)
│   ├── index.mjs        ← public entry-point: createCore({...}) wires host glue in
│   ├── runtime.mjs      ← renderPrompt / extractJsonObject / createRoleRunner
│   ├── selector/        ← generic SELECT workflow
│   ├── implementer/     ← generic IMPLEMENT workflow
│   ├── reviewer/        ← generic REVIEW workflow
│   ├── auditor/         ← generic AUDIT workflow
│   └── architect/       ← Stage-2 Architect Mode (macro-vision decomposition)
│
├── lib/                 ← ENGINE UTILITIES (open-sourceable)
│   ├── state.mjs        ← state.json load/save (atomic) + recovery
│   ├── claude.mjs       ← runs `claude -p`, parses JSON, detects rate limits
│   ├── git.mjs          ← branch / commit / merge / discard helpers
│   ├── validate.mjs     ← runs typecheck / lint / e2e
│   ├── files.mjs        ← regenerates the human-readable .md mirrors
│   └── …                ← budget-governor, circuit-breaker, key-manager, providers …
│
├── shared/              ← UNIVERSAL TYPE CONTRACTS (open-sourceable)
│   └── types.mjs        ← ContextProviderInterface, TASK_CLASS, PROVIDER_TYPE …
│
├── plugins/             ← REUSABLE EXTENSION MODULES (open-sourceable)
│   └── (add custom provider/context/scoring adapters here)
│
├── commercial/          ← PROJECT-SPECIFIC BINDINGS (private — gitignored)
│   └── config.json      ← model, validation commands, scoring weights, git targets,
│                           API key env-var names, budget limits (RushPoint / your project)
│
├── profiles/            ← WORKSPACE PROFILES (project-neutral engine; rushpoint is one profile)
│   ├── rushpoint.json   ← RushPoint backlog seed, task filters, prompt conventions
│   └── generic.json     ← blank profile for new projects
│
├── supervisor.mjs       ← the supervisor loop (wires commercial/ config into core/)
├── watchdog.mjs         ← process monitor / auto-restart
├── cli.mjs              ← unified command router
├── config-loader.mjs    ← resolves commercial/config.json → absolute paths (U-25, U-44)
└── state/               ← all runtime state (created by `init`; gitignored)
    ├── state.json       ← single source of truth (queues, stats, rate-limit, cursor)
    ├── backlog.md       ← human-readable task queue   (mirror of state.json)
    ├── done.md          ← completed queue             (mirror)
    ├── blocked.md       ← blocked queue + reasons      (mirror)
    ├── decision_log.md  ← one entry per cycle: choice + rationale + outcome
    └── handoff/         ← per-cycle JSON exchanged between supervisor ⇄ claude
```

`state.json` is the **single source of truth**. The `.md` files are regenerated from it every cycle
so they stay readable for a human without ever being parsed back (no fragile markdown parsing).

### Config resolution order

`config-loader.mjs` checks for `autopilot/commercial/config.json` first; if absent it falls back
to the legacy `autopilot/config.json`. This means:

- **Existing setups** keep working unchanged — `config.json` at the root continues to be read.
- **New deployments** drop their project config in `commercial/config.json`; the root file can be
  removed or kept as a template.

---

## 2b. Setting up for a new project (third-party quickstart)

```powershell
# 1. Copy the example config into the commercial layer
cp autopilot/config.json.example autopilot/commercial/config.json

# 2. Edit the project-specific values
#    - paths.appRoot / paths.appsDir … → your project layout
#    - validation.commands             → your typecheck / build / lint commands
#    - git.integrationBranch / baseBranch → your branch names
#    - models.*                        → model IDs for your provider
#    - provider / providers            → 'claude' (default), 'openrouter', or 'custom'

# 3. (Optional) select or create a workspace profile
#    Copy autopilot/profiles/generic.json → autopilot/profiles/<yourproject>.json
#    Set "profile": "<yourproject>" in commercial/config.json

# 4. Initialise and start
node autopilot/supervisor.mjs init
node autopilot/supervisor.mjs run
```

The engine has **no runtime knowledge of RushPoint** — all RushPoint specifics live in
`commercial/config.json` and `profiles/rushpoint.json`. Swapping those two files is all that is
needed to point the engine at a different project.

---

## 3. Start / stop / resume

### Prerequisites
- `claude` CLI on PATH (`claude --version`) and logged in (`claude` once, interactively).
- Node ≥ 20. Run everything from the repo root.

### Unified CLI (one entry point for every workflow)
`autopilot/cli.mjs` is a single command router over all the workflows below, so you don't have to
remember which file backs which job. It routes to the existing handlers unchanged (so the direct
`node autopilot/supervisor.mjs …` / `watchdog.mjs` commands keep working identically):
```powershell
node autopilot/cli.mjs --help          # list every command + the universal arguments
node autopilot/cli.mjs --version       # print the kinetic version
node autopilot/cli.mjs init            # = supervisor init
node autopilot/cli.mjs run             # = supervisor run
node autopilot/cli.mjs supervisor run  # explicit form (any supervisor subcommand is forwarded)
node autopilot/cli.mjs watchdog        # = watchdog.mjs
node autopilot/cli.mjs config          # print the resolved config paths
```
Universal arguments work on any command: `--help`, `--version`, `--config <path>`, `--debug`,
`--verbose`. (`bin: kinetic` is wired in `autopilot/package.json` for use as a global command.)

### Start (first time)
```powershell
node autopilot/supervisor.mjs init     # seeds state/ + a curated starter backlog, sets the 5-day deadline
node autopilot/supervisor.mjs run      # starts the autonomous loop
```
Or via the npm scripts added to package.json:
```powershell
npm run kinetic:init
npm run kinetic
```

Leave the terminal running. To run unattended in the background:
```powershell
Start-Process -NoNewWindow node -ArgumentList "autopilot/supervisor.mjs","run" -RedirectStandardOutput "autopilot/state/run.log" -RedirectStandardError "autopilot/state/run.err.log"
```

### Stop
- Press **Ctrl+C**. State is flushed after every step, so stopping is always safe.
- Hard kill is also safe — on next `run` the supervisor recovers (see Resume).

### Resume (after Ctrl+C, a crash, a reboot, or a rate-limit pause)
```powershell
node autopilot/supervisor.mjs run      # same command — it continues from state/state.json
```
On startup the supervisor:
1. Loads `state.json` (cycle counter, queues, deadline, rate-limit clock).
2. **Recovers** any interrupted cycle: re-queues the in-flight task, checks out the integration
   branch, and deletes dangling `kinetic/cycle-*` branches (integration is always clean).
3. If a rate-limit cooldown is still active, sleeps until it elapses.
4. Continues running cycles until the 5-day deadline.

### Check status without touching the loop
```powershell
node autopilot/supervisor.mjs status
```

### Where to read what it did
- `autopilot/state/decision_log.md` — narrative of every cycle (what + why + outcome).
- `autopilot/state/done.md` / `blocked.md` / `backlog.md` — the three queues.
- `git log kinetic/main` — the actual merged improvements.

---

## 4. Goal ordering (priority the selector is told to follow)

1. **Structure** — clean up project layout, keep the codebase organized.
2. **Features** — make existing features smarter and more reliable.
3. **UI** — polished, fast, attractive.
4. **Social sharing** — reward event visibility *healthily and fairly* (never manipulative).
5. **Admin / control-room** — manage the event with less manual intervention.
6. **Continuous** — keep proposing and shipping the next most valuable improvement.

The selector finishes the high-value work in the current phase before advancing, but always favors a
high-impact fix in a later phase over busywork in the current one. It must preserve existing behavior
unless a change is explicitly required, and it must downgrade (not skip) tasks that are too risky.

---

## 5. Safety properties (by design)

- **Integration branch is sacred.** `kinetic/main` only moves forward via a reviewed + validated
  merge. Failed/rejected/rate-limited cycles are discarded with `git`, leaving it untouched.
- **No lost context on restart.** Everything needed to resume lives in `state.json`; the in-flight
  task is re-queued on recovery.
- **No repeated low-value work.** Done and blocked queues are passed to the selector each cycle with
  an explicit "do not repeat these" instruction.
- **Bounded revision loop.** A task that can't pass review within `maxReviseAttempts` is blocked with
  a reason rather than retried forever.
- **Tunable autonomy.** Permissions, validation commands, model, cadence, and cooldowns all live in
  `config.json`.
