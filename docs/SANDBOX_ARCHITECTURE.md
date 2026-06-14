# Sandbox Architecture (U-62)

## Overview

The sandbox execution seam isolates each tenant's shell, git, and file operations
within a dedicated worktree boundary, preventing untrusted tenant repositories from
accessing the host system or other tenants' directories.

---

## Isolation Boundary Contract

Every operation that touches the filesystem, invokes a shell, or runs a git command
MUST flow through the sandbox interface. The invariant is:

> **No file path may resolve outside `worktreeRoot` once enforcement is active.**

The boundary is the absolute, resolved path of the tenant's worktree root. Operations
that attempt to cross it — via `../..` path traversal, absolute paths to other
directories, or symlink tricks — are rejected with an `IsolationViolationError`.

---

## Module Map

| Module | Role |
|---|---|
| `core/sandbox.mjs` | Sandbox / WorktreeExecutor / PassthroughExecutor classes + `createSandbox()` factory |
| `core/pathValidator.mjs` | `validatePath()` and `isWithinWorktree()` — pure path-boundary functions |

### `core/pathValidator.mjs`

Two synchronous, pure exports:

```
isWithinWorktree(filePath, root) → boolean
  Returns true when filePath resolves to root or any path below it.
  Handles path traversal (../), redundant slashes, and absolute paths.

validatePath(filePath, worktreeRoot) → string (resolved absolute path)
  Resolves filePath against worktreeRoot and throws if it escapes the boundary.
  Also rejects null, undefined, and empty-string filePaths.
```

### `core/sandbox.mjs`

Three classes + one factory:

```
SandboxExecutor (abstract base)
  execShell(), gitCommand(), readFile(), writeFile(), globFiles()

WorktreeExecutor extends SandboxExecutor
  Validates every file path via _assertPath() (prefix-check against sandboxRoot).
  Shell commands run with cwd = sandboxRoot.
  Throws IsolationViolationError for any out-of-boundary access.

PassthroughExecutor extends SandboxExecutor
  Transparent no-op wrapper. All operations pass through without validation.
  Used when sandbox.enabled === false (default single-tenant behavior).

Sandbox (public API class — U-62)
  Constructor: new Sandbox(worktreeRoot, options?)
  Methods: runShell(), runBash(), runPowerShell(), execGit(), readFile(), writeFile()
  Properties: timeoutMs, maxMemoryMb, maxDiskMb (resource-limit stubs — see below)
  File ops validate paths via isWithinWorktree(); shell ops lock cwd to worktreeRoot.

createSandbox(config, fallbackRoot) → SandboxExecutor
  Returns WorktreeExecutor when config.enabled = true, PassthroughExecutor otherwise.
```

---

## Operation Routing Flow

All tenant-facing operations in the kinetic engine are routed through the `SANDBOX`
instance created at supervisor startup:

```
supervisor.mjs
  const SANDBOX = createSandbox(sandboxConfig, GIT_ROOT)
    │
    ├─ SANDBOX.runShell(testCmd, { cwd: GIT_ROOT })   ← test-runner execution
    │
    └─ runValidation(..., { sandbox: SANDBOX })        ← typecheck / lint / build
         └─ uses SANDBOX.execShell() internally

watchdog.mjs
  sandboxResolvedLine()  ← logs active sandbox config on startup
  (engine-internal shell ops in syncKineticRepo are exempt — they operate on
   the kinetic engine repo itself, not tenant code)
```

### What counts as a "tenant operation"

- Any shell or git command that executes code from the tenant repository
- File reads/writes to paths that could contain tenant-controlled content
- Validation (typecheck/lint/build) that runs the tenant's toolchain

### What is exempt from the sandbox

- Engine-internal git operations (e.g. `syncKineticRepo` in watchdog): these
  operate on the kinetic engine's own repo at `__dirname`, not tenant paths.
- Spawning the supervisor or watchdog processes: these are engine lifecycle operations.
- Reading/writing the engine's own state files (state.json, logs, locks): these live
  in the engine directory, outside the tenant worktree.

---

## Path Validation Rules

1. **Resolve first.** Use `path.resolve(root, filePath)` to normalize the path
   (handles `../..`, double slashes, and mixed absolute/relative).

2. **Prefix check.** The resolved path must equal `root` OR start with `root + sep`.
   Both are checked to handle the case where `filePath === root`.

3. **Reject early.** `null`, `undefined`, and empty-string paths are rejected
   before resolution — they represent programmer errors, not boundary violations.

4. **Cross-platform.** `path.sep` is used for the boundary check so `\` on Windows
   and `/` on Unix both work correctly.

**Valid:**
- `./src/file.js` (relative, within root)
- `/worktree/src/file.js` (absolute, within root)
- `/worktree` (the root itself)

**Rejected:**
- `../etc/passwd` (traversal)
- `/worktree/src/../../etc/passwd` (traversal via abs path)
- `/other-tenant/file.js` (different directory tree)
- `''`, `null`, `undefined` (invalid input)

---

## Resource-Limit Stubs

The `Sandbox` class exposes three resource-limit properties as **stubs** — they are
defined and configurable, but **not yet enforced at runtime**.

```
timeoutMs    default: 30 000 ms  — per-operation wall-clock timeout
maxMemoryMb  default: 512 MB     — memory ceiling for spawned processes
maxDiskMb    default: 1 024 MB   — disk-write quota for the worktree
```

**Why enforcement is deferred:** Runtime resource limiting requires OS-level primitives
(cgroup limits on Linux, Job Objects on Windows). Implementing this correctly without
a regression risk across all supported platforms warrants a dedicated hardening phase.
The stubs define the interface today so callers can pass limits; the next phase
activates them by wiring the values into the spawn options and monitoring loops.

**How enforcement will integrate (follow-up hardening phase):**
- `timeoutMs` → `timeout` option passed to `exec`/`execFile` calls
- `maxMemoryMb` → cgroup `memory.limit_in_bytes` on Linux; `Job Object` quota on Windows
- `maxDiskMb` → `inotify`/`FSEvents` hook or periodic `du` check in the executor loop

---

## Config Integration

Sandbox behavior is controlled by `config.json → sandbox`:

```json
{
  "sandbox": {
    "enabled": false,
    "path": null
  }
}
```

- `enabled: false` (default) → `PassthroughExecutor` (single-tenant, no-op — zero
  behavior change for existing deployments).
- `enabled: true` → `WorktreeExecutor` with boundary = `sandbox.path` or `GIT_ROOT`.

The config is loaded and logged at startup via `sandboxResolvedLine()` — both
supervisor and watchdog emit this line so the active mode is always visible in logs.

---

## Multi-Tenant Isolation

Each tenant workspace gets its own `Sandbox` instance with its `worktreeRoot` set
to the tenant's dedicated worktree path (resolved by `lib/workspace-registry.mjs`).
Because the boundary is per-instance, tenants in concurrent processes can never access
each other's files even if they share a host — the path check is purely local to each
instance.
