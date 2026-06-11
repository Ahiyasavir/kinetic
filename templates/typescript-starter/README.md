# Template: typescript-starter

Minimal working configuration for running the autopilot engine against a TypeScript project.

## Files

| File | Purpose |
|---|---|
| `config.json` | Engine config — TypeScript validation commands, model routing, cycle settings |
| `profile.json` | Workspace profile — goal phases, task-selection filters, starter seed backlog |

## Quickstart

```powershell
# 1. Copy config into the commercial layer
cp autopilot/templates/typescript-starter/config.json autopilot/commercial/config.json

# 2. Copy the profile
cp autopilot/templates/typescript-starter/profile.json autopilot/profiles/typescript-starter.json

# 3. Edit commercial/config.json:
#    - paths.appRoot → your project root (relative to autopilot/ parent)
#    - validation.commands → your actual typecheck / build / lint commands
#    - git.integrationBranch / git.baseBranch → your branch names
#    - models.* → model IDs for your provider (or keep as-is for Claude defaults)

# 4. Initialise state and start
node autopilot/supervisor.mjs init
node autopilot/supervisor.mjs run
```

## What the engine does

Once running, the engine selects the highest-priority task from the backlog, implements it in an
isolated git branch, validates it (using your `validation.commands`), reviews the diff with a
second agent, and merges it if approved — all autonomously. See `autopilot/docs/INTEGRATION.md`
for the full onboarding guide including plugin authoring and feature-flag reference.

## Customising the seed backlog

Edit `profile.json → seed[]` before running `init`, or drop Markdown task files into
`autopilot/inbox/` at any time while the loop is running.

## Next steps

- Add more tasks via `autopilot/inbox/` (plain Markdown, one task per file).
- Add a plugin: drop a module in `autopilot/plugins/` and register it in `commercial/config.json`.
- Enable budget governance: set `budgetGovernor.enabled: true` and `weeklyTokenQuota` in config.
- Full reference: `autopilot/docs/INTEGRATION.md`.
