# Git configuration & third-party portability (U-35)

The kinetic's git operations are **config-driven**. By default the engine drives the repository it
lives in (the RushPoint checkout), but `autopilot/config.json → git` can point it at **any external
repository / branch** — and optionally manage that target in a dedicated git **worktree** — with **no
engine code change**. This mirrors the U-25/U-31/U-32 config-driven path seams.

## The `git` config block

```jsonc
"git": {
  "integrationBranch": "autopilot/topo",   // branch all reviewed work lands on
  "baseBranch": "topographic-maps",         // where the integration branch forks from
  "commitPrefix": "kinetic",              // auto-commit message prefix

  // ── OPTIONAL portability fields (U-35) — omit to keep the in-place layout ──
  "repository": "../some-other-repo",       // target repo (relative to autopilot/ parent, or absolute)
  "branch": "main",                          // active branch (default = integrationBranch)
  "worktreeName": "kinetic-worktree"      // manage target in a worktree (sibling of `repository`)
}
```

| Field | Default | Meaning |
|---|---|---|
| `repository` | `.` (the repo the kinetic lives in) | Path to the target repo. Relative paths resolve against the `autopilot/` parent; absolute paths are honored as-is. |
| `branch` | `integrationBranch` | The branch the engine checks out and commits to. |
| `worktreeName` | *(absent → in-place)* | If set, the engine manages a git worktree of `repository` placed as a **sibling** directory with this name, and runs all git/file operations there instead of in the repo's primary working tree. |

## How it resolves

`autopilot/lib/git-config-loader.mjs` exports a **pure** `resolveGitConfig(config)` that returns the
resolved absolute paths and the git config object:

```js
import { resolveGitConfig, gitConfig } from './lib/git-config-loader.mjs';
const r = resolveGitConfig(config);
// → { repository, branch, worktreeName, worktreePath, cwd, integrationBranch, baseBranch, commitPrefix, ... }
//   cwd = worktreePath when a worktree is configured, otherwise repository — the single value git.* ops use.
```

Verify the live resolution any time:

```bash
node autopilot/lib/git-config-loader.mjs
```

## Startup wiring

- **`watchdog.mjs`** initializes the git target on startup: it logs `gitConfigResolvedLine()`,
  **creates the configured worktree if absent** (`git.ensureWorktree`), and launches the supervisor
  with cwd = the resolved working-tree root, exporting `KINETIC_GIT_ROOT` so the supervisor's git
  operations target the identical path.
- **`supervisor.mjs`** runs every `git.*` operation against `GIT_ROOT` (`= KINETIC_GIT_ROOT` →
  `gitConfig.cwd`), never a hardcoded `__dirname`/relative path. It also wires the core role runtime
  (`createCore({ cwd: GIT_ROOT })`) at that same root, so **all four role agents
  (selector/implementer/reviewer/auditor) read and edit the configured target repo/worktree** — no
  per-role code change is needed to retarget the engine.

## Backward compatibility

Omitting all three optional fields (the current RushPoint config) keeps the **exact** prior behavior:
`repository` resolves to the kinetic's own repo root, `branch` falls back to `integrationBranch`, and
no worktree is created — the engine operates in-place. `resolveGitConfig({})` reports `fromConfig:false`.

## Onboarding a third-party project

1. Set `git.repository` to the target repo (and `git.branch` to the branch to manage).
2. Optionally set `git.worktreeName` to isolate the engine's checkout from your primary working tree.
3. Point the `paths` and `validation` blocks (U-25/U-26) at that project's layout + build commands.
4. Start the watchdog — it creates/attaches the worktree and runs the loop against your repo.

Covered end-to-end by `node autopilot/tests/git-config.mjs` (includes managing a worktree for a
brand-new, non-RushPoint test repository).
