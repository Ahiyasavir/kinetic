# 📥 Kinetic inbox — add your own tasks, anytime

Drop work here whenever you want. The supervisor checks this folder at the **start of every cycle**
(even while it is running), turns each new file into a task, gives it **top priority over everything
else**, expands it into a real spec, builds it, reviews it, validates it, and merges it onto
`autopilot/topo` — then archives the file into `processed/`.

## Two ways to add a task

**1. One-liner from the terminal (easiest):**
```powershell
cd C:\Users\savir\Projects\Rushpoint-kinetic
node autopilot/supervisor.mjs add "make the leaderboard pulse gold when a team is overtaken"
```

**2. Drop a file** named anything ending in `.md` / `.txt` into this folder. The **first line is the
title**, the rest is detail / acceptance criteria. Example `boost-map.md`:
```
Add a "you are here" pulsing dot to the mobile mission map
goal: ui
risk: 2
The dot should follow the device GPS and animate gently. Keep EN/HE + the premium theme.
```

### Optional steering lines (anywhere in the body)
- `goal:` one of `ui · gameplay · admin · reliability · stations · builder · review · social`
- `risk:` `1`–`5` (engineering risk)  ·  `effort:` `1`–`5` (size)

If you omit them, sensible defaults are used and the selector figures out the rest.

## Where to watch it
- `node autopilot/supervisor.mjs status` → shows pending ★USER tasks and whether the loop is running.
- `autopilot/run.log` → live cycle log (the ingest prints `📥 Ingested N USER task(s)`).
- `autopilot/state/decision_log.md` → what was built and why, per cycle.
- `git log autopilot/topo --oneline` → the merged results.

## Guarantees
- A user task is **always built before** any auto-generated task.
- It is **ingested exactly once** (the file moves to `processed/`).
- It is **never silently lost** — if it fails review it is retried, then blocked **with a reason**
  you can read in `autopilot/state/blocked.md`.
