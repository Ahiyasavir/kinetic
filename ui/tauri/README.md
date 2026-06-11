# Kinetic — Control Center (`ui/tauri/`)

Desktop shell for the Kinetic autonomous coding engine. A Tauri v2 app that wraps a React/TypeScript
frontend in a native WebView2 window and manages the Node.js control server as a child process.

---

## Architecture

```
┌─────────────────────────────────────────────┐
│            Tauri shell (Rust)               │
│  src-tauri/src/main.rs + commands.rs        │
│  5 invoke() commands   ┆  plugin-dialog      │
└──────────────┬──────────────────────────────┘
               │ Tauri IPC (invoke)
┌──────────────▼──────────────────────────────┐
│        React frontend (TypeScript)          │
│  src/  ←  Vite dev server / bundled dist    │
│  ┌───────────┐  ┌──────────┐  ┌──────────┐ │
│  │ Dashboard │  │ Backlog  │  │ Settings │ │
│  └───────────┘  └──────────┘  └──────────┘ │
│  src/api/control.ts  (typed fetch wrappers) │
└──────────────┬──────────────────────────────┘
               │ fetch() — http://127.0.0.1:4317
┌──────────────▼──────────────────────────────┐
│  Node.js control server  (ui/server.mjs)    │
│  JSON HTTP API — loopback only, port 4317   │
└──────────────┬──────────────────────────────┘
               │ fs read/write
┌──────────────▼──────────────────────────────┐
│  Engine state  (autopilot/state/state.json) │
│  Config        (autopilot/config.json)      │
└─────────────────────────────────────────────┘
```

### Two communication planes — never mix them

| Plane | Mechanism | Used for |
|---|---|---|
| **Engine data** | `fetch()` → `http://127.0.0.1:4317` | All task/queue/stats/config reads and writes |
| **OS integration** | Tauri `invoke()` | Spawn/kill the Node process, read/write config.json, native folder picker |

The React code must never call `invoke()` for data that the HTTP API can serve, and must never
call `fetch()` to perform process lifecycle operations. The typed wrappers in `src/api/control.ts`
enforce this boundary.

---

## Directory layout

```
ui/tauri/
├── src/                        # React + TypeScript frontend
│   ├── main.tsx                # Vite entry point
│   ├── App.tsx                 # Router root
│   ├── api/
│   │   └── control.ts          # Typed fetch() wrappers for all /api/* endpoints
│   ├── pages/
│   │   ├── Dashboard.tsx       # Live engine status, task progress, key pool health
│   │   ├── Backlog.tsx         # Topological DAG view — lane layout + SVG bezier edges
│   │   └── Settings.tsx        # Visual api_pools editor + config knobs
│   ├── components/             # Shared UI primitives
│   └── wizard/
│       └── FirstLaunchWizard.tsx  # One-time setup: workspace folder + first API key
├── src-tauri/
│   ├── src/
│   │   ├── main.rs             # Tauri builder, EngineState, WindowEvent::Destroyed handler
│   │   └── commands.rs         # 5 #[tauri::command] functions (see below)
│   ├── capabilities/
│   │   └── default.json        # Grants core:default + dialog:default to the main window
│   ├── icons/                  # App icons (all sizes; replace for production branding)
│   ├── Cargo.toml              # Crate: kinetic; deps: tauri, plugin-shell, plugin-dialog, serde_json
│   ├── tauri.conf.json         # Product name, window size, CSP, dev/build commands
│   └── build.rs                # Tauri code-gen hook (do not remove)
├── index.html                  # Vite HTML entry
├── vite.config.ts
├── tsconfig.json
└── package.json                # npm scripts: dev, build, tauri dev, tauri build
```

---

## Rust commands (`src-tauri/src/commands.rs`)

Five `#[tauri::command]` functions are registered; no others exist or should be added without a
clear reason that `fetch()` cannot satisfy.

| Command | Signature | Behavior |
|---|---|---|
| `start_engine` | `(server_path: String) → Result<u32, String>` | Spawns `node <server_path>` in the server's directory; returns PID. Errors if already running or path not found. stdout/stderr suppressed — control center polls via HTTP. |
| `stop_engine` | `() → Result<(), String>` | Kills the child and waits to reap it. Idempotent — no-op if nothing is running. |
| `engine_running` | `() → bool` | Returns `true` if the child process is still alive (uses `try_wait`). Clears stale handles. |
| `read_config` | `(config_path: String) → Result<String, String>` | Reads a file as UTF-8. Used by Settings to load `config.json`. |
| `write_config` | `(config_path: String, json: String) → Result<(), String>` | Validates JSON, then atomically writes via a `.json.tmp` temp file + rename. A mid-write crash cannot corrupt the original. |

The native folder picker is handled by `@tauri-apps/plugin-dialog` directly in JavaScript (`open()`
from the plugin) — no extra Rust wrapper is needed.

### EngineState

`EngineState { child: Mutex<Option<Child>> }` is managed by Tauri and shared across all command
invocations. The `WindowEvent::Destroyed` handler in `main.rs` calls `child.kill()` + `child.wait()`
on window close so Node can flush pending I/O before the OS reclaims it.

---

## Control server API endpoints (`ui/server.mjs`)

All endpoints are JSON over HTTP, bound to `127.0.0.1:4317` only (never exposed beyond loopback).

| Method | Path | Returns |
|---|---|---|
| `GET` | `/api/status` | Engine loop status, cycle count, active task |
| `GET` | `/api/queues` | Task queues (backlog / in-progress / done) |
| `GET` | `/api/graph` | Full task graph with `deps` + `parent_task_id` intact (used by Backlog DAG page) |
| `GET` | `/api/stats` | Budget consumed, token counts, cost estimate |
| `GET` | `/api/keys` | Key pool snapshot — `id`, `provider`, `key_env`, `daily_budget`, `current_usage`, `status`, `retry_after`. **Never includes secret values.** |
| `POST` | `/api/pause` | Pause the engine loop after the current task completes |
| `POST` | `/api/resume` | Resume a paused engine |
| `POST` | `/api/config` | Write updated config JSON (validated before save) |

The `src/api/control.ts` module exports one typed wrapper per endpoint. Every page imports from
there — never constructs URLs by hand.

---

## Security constraints (hard rules — do not regress)

**Secrets are never stored or transmitted through the UI layer.**

`api_pools` entries in `config.json` carry only `key_env` — the *name* of an environment variable.
The actual API token is read from `process.env` in the Node.js process at runtime. The Settings page
lets users add/remove pool entries by editing `key_env` strings. It must never expose or accept a
raw API key.

**Additive only — never modify the engine core.**

The directories `autopilot/lib/`, `autopilot/core/`, `autopilot/tests/`, and the engine loop files
(`supervisor.mjs`, `watchdog.mjs`, `cli.mjs`) are off-limits to this package. The Tauri shell is a
consumer of the control server, not a component of the engine.

**The standalone browser UI stays working.**

`ui/public/index.html` is a fully independent HTML dashboard that runs in any browser against the
same control server. Changes to `server.mjs` must remain backwards-compatible with it. Do not add
authentication or break any existing endpoint contract.

**CSP enforces the data-plane boundary.**

`tauri.conf.json` includes:
```
"connect-src 'self' http://127.0.0.1:4317"
```
WebView2 will block any `fetch()` call to a host not on this list. Do not loosen it.

---

## Local development

### Prerequisites (one-time)

| Requirement | Notes |
|---|---|
| **Node.js ≥ 20** | Must be on PATH |
| **Rust + Cargo** | Install via `rustup` |
| **MSVC toolchain** (Windows) | VS 2022 Build Tools with `VC.Tools.x86.x64` + Windows 11 SDK. Install with: `winget install Microsoft.VisualStudio.2022.BuildTools --override "--add Microsoft.VisualStudio.Component.VC.Tools.x86.x64 --add Microsoft.VisualStudio.Component.Windows11SDK.26100"` |
| **WebView2** | Pre-installed on Windows 10 20H2+ / Windows 11. No action needed. |

After installing Build Tools, open a new terminal so PATH updates take effect, or prefix commands with:
```powershell
$env:PATH = [System.Environment]::GetEnvironmentVariable("PATH","Machine") + ";" + $env:PATH
```

### Start the dev build

```bash
# From repo root — starts control server + Tauri dev window with HMR
npm run ui:tauri          # shortcut in autopilot/package.json

# Or from this directory
npm run tauri dev
```

Tauri's `beforeDevCommand` runs `npm run dev` (Vite on `:1420`) first, then opens the WebView2
window pointed at that dev server. React edits hot-reload; Rust edits require a full rebuild
(Tauri handles this automatically).

The control server must be running separately for engine data to appear in the UI:
```bash
# From repo root
npm run ui                # node autopilot/ui/server.mjs
```

Or start the full engine loop:
```bash
node autopilot/watchdog.mjs
```

### Build for distribution

```bash
npm run ui:tauri:build    # from repo root
# or
npm run tauri build       # from this directory
```

Produces a `.msi` installer (Windows) and a portable `.exe` in `src-tauri/target/release/`.
The bundle includes the WebView2 bootstrapper for machines that don't have it pre-installed.

### Verify the Rust layer compiles (no window)

```bash
cd src-tauri
cargo check
```

---

## React pages

### Dashboard (`src/pages/Dashboard.tsx`)

Live engine status panel. Polls `/api/status`, `/api/queues`, `/api/stats`, and `/api/keys` on a
short interval. Shows:
- Engine on/off toggle (calls `start_engine` / `stop_engine` via `invoke()`)
- Active task title, cycle count, budget consumed
- Key pool health — per-key status badges (`active` / `rate-limited` / `exhausted`) with `retry_after`
  countdown. Secret values are never shown; only `key_env` (the env-var name) is displayed.
- Pause / resume button (POST to `/api/pause` / `/api/resume`)

### Backlog DAG (`src/pages/Backlog.tsx`)

Topological view of the full task graph. Fetches from `/api/graph` (which preserves `deps` and
`parent_task_id` fields). Layout algorithm:
- Assign `lane = max(dependency lanes) + 1` (pure function, no library)
- Tasks with no dependencies get `lane = 0`
- SVG cubic bezier edges connect dependency arrows
- Color-coded by status: backlog (grey) / in-progress (amber) / done (green) / blocked (red)

### Settings (`src/pages/Settings.tsx`)

Visual editor for `autopilot/config.json`. Uses `read_config` / `write_config` via `invoke()`.
Key sections:
- **API Pools** — add/remove pool entries. Each entry has `key_env` (env-var name), `provider`,
  `daily_budget`. Raw API keys are never entered here; users set the actual env var in their shell.
- **Scoring knobs** — `maxReviewFailAttempts`, `maxAttemptsBeforeBlock`
- **Budget limits** — `dailyBudgetUSD`, token caps

### First-Launch Wizard (`src/wizard/FirstLaunchWizard.tsx`)

Shown once on first run (when no workspace is configured). Three steps:
1. **Workspace folder** — native `open()` call via `@tauri-apps/plugin-dialog` to pick the project root
2. **First API key** — prompts for the environment variable *name* (`ANTHROPIC_API_KEY`, `OPENAI_API_KEY`, etc.); confirms the var is set in the current shell environment
3. **Confirm** — writes initial `config.json` via `write_config`

After the wizard completes it is not shown again.

---

## Theming

The frontend uses a dark theme matching the Kinetic engine aesthetic. Design tokens live in
`src/components/tokens.ts`. The palette follows the same semantic naming convention as the
RushPoint mobile app (`bg-app-bg`, `text-neon-green`, etc.) so both dashboards can share token
definitions if a future monorepo integration occurs.

CSS is Tailwind via `@vitejs/plugin-react`. Static class strings only — no dynamic `bg-${x}`
template expressions (Tailwind's JIT cannot tree-shake them).

---

## Adding a new endpoint

1. Add the route to `ui/server.mjs` (additive only — do not modify existing routes).
2. Add a typed wrapper in `src/api/control.ts`.
3. Import and use the wrapper in your page component.
4. Do not `invoke()` for the new data — `fetch()` through `control.ts` is the correct path.

## Adding a new Rust command

Only add a Rust command if the operation is genuinely OS-level (process management, native dialog,
atomic file writes). For everything else, use the HTTP API.

1. Add the function to `src-tauri/src/commands.rs` with `#[tauri::command]`.
2. Register it in the `invoke_handler![]` macro in `main.rs`.
3. Add a typed wrapper in `src/api/invoke.ts` (create the file if it doesn't exist yet).
4. Run `cargo check` to confirm the Rust compiles before opening a PR.
