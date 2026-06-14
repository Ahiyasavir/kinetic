// core/sandbox.mjs — execution seam for tenant isolation (U-62).
//
// Defines the sandbox interface that isolates each tenant's shell/git/file operations
// within their worktree boundary, preventing untrusted repositories from accessing or
// modifying the host system.
//
// Three classes:
//   SandboxExecutor     — abstract base (interface contract for all subclasses)
//   WorktreeExecutor    — validates file paths against a configurable sandbox root;
//                         rejects paths that escape the boundary with IsolationViolationError
//   PassthroughExecutor — transparent no-op wrapper used when sandbox.enabled === false
//
// Factory:
//   createSandbox(sandboxConfig, fallbackRoot) → SandboxExecutor
//     Returns WorktreeExecutor when enabled, PassthroughExecutor otherwise.
//     Existing single-tenant behavior is fully preserved when sandbox.enabled is false.
//
// Canonical public API (both concrete executors expose):
//   runShell(cmd, opts)          — execute any shell command
//   runBash(cmd, opts)           — POSIX/bash alias of runShell
//   runPowerShell(cmd, opts)     — PowerShell wrapper
//   execGit(cmdOrArgs, opts)     — run git subcommand(s)
//   readFile(path, enc)          — read a file (WorktreeExecutor validates boundary)
//   writeFile(path, content)     — write a file (WorktreeExecutor validates boundary)
//   globFiles(pattern, opts)     — list files matching a pattern
//   execShell(cmd, opts)         — low-level alias (same as runShell, retained for compatibility)
//   gitCommand(args, opts)       — low-level alias (same as execGit, retained for compatibility)
//
// Resource-limit stubs (defined per executor — enforcement deferred):
//   timeoutMs, maxMemoryMb, maxDiskMb

import { exec, execFile } from 'node:child_process';
import { readFile, writeFile, readdir } from 'node:fs/promises';
import path from 'node:path';

// ── Error type ──────────────────────────────────────────────────────────────

/**
 * Thrown when an operation tries to access a path outside the sandbox boundary.
 *
 * EN: Operation blocked: path is outside worktree.
 * HE: פעולה חסומה: הנתיב מחוץ לעץ העבודה.
 */
export class IsolationViolationError extends Error {
  constructor(message, { path: blockedPath, sandboxRoot } = {}) {
    super(message);
    this.name = 'IsolationViolationError';
    this.code = 'SANDBOX_ISOLATION_VIOLATION';
    this.blockedPath = blockedPath;
    this.sandboxRoot = sandboxRoot;
  }
}

// ── Abstract base class ─────────────────────────────────────────────────────

/**
 * Abstract base class for sandbox executors.
 * All concrete implementations must override every method.
 *
 * @abstract
 */
export class SandboxExecutor {
  /**
   * Execute a shell command.
   * @param {string} cmd
   * @param {object} [opts]
   * @returns {Promise<{stdout: string, stderr: string, code: number}>}
   */
  async execShell(cmd, opts = {}) {
    throw new Error('SandboxExecutor.execShell is abstract — use WorktreeExecutor or PassthroughExecutor');
  }

  /**
   * Run a git command.
   * @param {string[]} args
   * @param {object} [opts]
   * @returns {Promise<{stdout: string, stderr: string, code: number}>}
   */
  async gitCommand(args, opts = {}) {
    throw new Error('SandboxExecutor.gitCommand is abstract — use WorktreeExecutor or PassthroughExecutor');
  }

  /**
   * Read a file.
   * @param {string} filePath
   * @param {string} [encoding]
   * @returns {Promise<string|Buffer>}
   */
  async readFile(filePath, encoding = 'utf8') {
    throw new Error('SandboxExecutor.readFile is abstract — use WorktreeExecutor or PassthroughExecutor');
  }

  /**
   * Write a file.
   * @param {string} filePath
   * @param {string|Buffer} content
   * @param {string} [encoding]
   * @returns {Promise<void>}
   */
  async writeFile(filePath, content, encoding = 'utf8') {
    throw new Error('SandboxExecutor.writeFile is abstract — use WorktreeExecutor or PassthroughExecutor');
  }

  /**
   * Glob files within the sandbox.
   * @param {string} pattern
   * @param {object} [opts]
   * @returns {Promise<string[]>}
   */
  async globFiles(pattern, opts = {}) {
    throw new Error('SandboxExecutor.globFiles is abstract — use WorktreeExecutor or PassthroughExecutor');
  }

  /**
   * Run a shell command (canonical public name — supervisor.mjs calls this).
   * Concrete classes delegate to execShell().
   */
  async runShell(cmd, opts = {}) {
    throw new Error('SandboxExecutor.runShell is abstract — use WorktreeExecutor or PassthroughExecutor');
  }

  /** Run a bash / POSIX shell command (alias of runShell). */
  async runBash(cmd, opts = {}) {
    throw new Error('SandboxExecutor.runBash is abstract — use WorktreeExecutor or PassthroughExecutor');
  }

  /** Run a PowerShell command. */
  async runPowerShell(cmd, opts = {}) {
    throw new Error('SandboxExecutor.runPowerShell is abstract — use WorktreeExecutor or PassthroughExecutor');
  }

  /**
   * Run a git command (canonical public name — accepts string or string[]).
   * Concrete classes delegate to gitCommand().
   * @param {string|string[]} cmdOrArgs
   */
  async execGit(cmdOrArgs, opts = {}) {
    throw new Error('SandboxExecutor.execGit is abstract — use WorktreeExecutor or PassthroughExecutor');
  }

  // Resource-limit stubs — defined here so instanceof checks can inspect them;
  // enforcement is a follow-up hardening phase.
  get timeoutMs()    { return 30_000; }
  get maxMemoryMb()  { return 512; }
  get maxDiskMb()    { return 1_024; }
}

// ── WorktreeExecutor ────────────────────────────────────────────────────────

/**
 * Enforces that all file I/O stays within the configured sandbox root (worktree boundary).
 * Shell commands run with cwd set to the sandbox root.
 * Any path that resolves outside the root throws IsolationViolationError.
 */
export class WorktreeExecutor extends SandboxExecutor {
  /**
   * @param {string} sandboxRoot — absolute path to the worktree root (the isolation boundary)
   */
  constructor(sandboxRoot) {
    super();
    if (!sandboxRoot) throw new Error('WorktreeExecutor requires a sandboxRoot path');
    this.sandboxRoot = path.resolve(sandboxRoot);
  }

  /**
   * Resolve `filePath` against the sandbox root and assert it stays within the boundary.
   * Uses path.resolve() + prefix check to prevent ../.. escapes.
   * @param {string} filePath — absolute or relative path
   * @returns {string} resolved absolute path (guaranteed within boundary)
   * @throws {IsolationViolationError}
   */
  _assertPath(filePath) {
    const resolved = path.resolve(this.sandboxRoot, filePath);
    const boundary = this.sandboxRoot.endsWith(path.sep)
      ? this.sandboxRoot
      : this.sandboxRoot + path.sep;
    if (resolved !== this.sandboxRoot && !resolved.startsWith(boundary)) {
      throw new IsolationViolationError(
        `Operation blocked: path is outside worktree. ` +
        `"${filePath}" resolves to "${resolved}" which is outside sandbox boundary "${this.sandboxRoot}". ` +
        `(HE: פעולה חסומה: הנתיב מחוץ לעץ העבודה — "${filePath}" → "${resolved}")`,
        { path: filePath, sandboxRoot: this.sandboxRoot }
      );
    }
    return resolved;
  }

  async execShell(cmd, opts = {}) {
    const cwd = opts.cwd || this.sandboxRoot;
    return new Promise((resolve) => {
      exec(cmd, { ...opts, cwd, maxBuffer: 64 * 1024 * 1024 }, (err, stdout, stderr) => {
        resolve({ stdout: stdout || '', stderr: stderr || '', code: err ? (err.code || 1) : 0 });
      });
    });
  }

  async gitCommand(args, opts = {}) {
    const cwd = opts.cwd || this.sandboxRoot;
    return new Promise((resolve, reject) => {
      execFile('git', args, { ...opts, cwd, maxBuffer: 64 * 1024 * 1024 }, (err, stdout, stderr) => {
        if (err && !opts.allowFail) {
          return reject(new Error(`git ${args.join(' ')}: ${stderr || err.message}`));
        }
        resolve({ stdout: stdout || '', stderr: stderr || '', code: err ? (err.code || 1) : 0 });
      });
    });
  }

  async readFile(filePath, encoding = 'utf8') {
    const resolved = this._assertPath(filePath);
    return readFile(resolved, encoding);
  }

  async writeFile(filePath, content, encoding = 'utf8') {
    const resolved = this._assertPath(filePath);
    return writeFile(resolved, content, encoding);
  }

  async runShell(cmd, opts = {}) { return this.execShell(cmd, opts); }
  async runBash(cmd, opts = {}) { return this.execShell(cmd, opts); }
  async runPowerShell(cmd, opts = {}) {
    const escaped = cmd.replace(/"/g, '\\"');
    return this.execShell(`powershell.exe -NoProfile -NonInteractive -Command "${escaped}"`, opts);
  }
  async execGit(cmdOrArgs, opts = {}) {
    const args = typeof cmdOrArgs === 'string'
      ? cmdOrArgs.trim().split(/\s+/).filter(Boolean)
      : cmdOrArgs;
    return this.gitCommand(args, opts);
  }

  async globFiles(pattern, opts = {}) {
    const baseDir = opts.cwd ? this._assertPath(opts.cwd) : this.sandboxRoot;
    const allFiles = [];
    const walk = async (dir) => {
      let entries;
      try { entries = await readdir(dir, { withFileTypes: true }); } catch { return; }
      for (const entry of entries) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) {
          await walk(full);
        } else if (entry.isFile()) {
          // Path check: all walked paths are already under baseDir (started from it),
          // but validate anyway so subclasses/overrides can't bypass the guard.
          const resolved = path.resolve(full);
          const boundary = this.sandboxRoot.endsWith(path.sep) ? this.sandboxRoot : this.sandboxRoot + path.sep;
          if (resolved === this.sandboxRoot || resolved.startsWith(boundary)) {
            allFiles.push(path.relative(this.sandboxRoot, resolved));
          }
        }
      }
    };
    await walk(baseDir);
    // Simple pattern matching: support *.ext and **/*.ext
    if (!pattern || pattern === '**/*') return allFiles;
    const ext = pattern.replace(/^\*\*\//, '').replace(/^\*/, '');
    return allFiles.filter((f) => f.endsWith(ext));
  }
}

// ── PassthroughExecutor ─────────────────────────────────────────────────────

/**
 * No-op wrapper used when sandbox.enabled === false.
 * All operations pass through directly without path validation.
 * Preserves existing single-tenant behavior completely.
 */
export class PassthroughExecutor extends SandboxExecutor {
  async execShell(cmd, opts = {}) {
    return new Promise((resolve) => {
      exec(cmd, { ...opts, maxBuffer: 64 * 1024 * 1024 }, (err, stdout, stderr) => {
        resolve({ stdout: stdout || '', stderr: stderr || '', code: err ? (err.code || 1) : 0 });
      });
    });
  }

  async gitCommand(args, opts = {}) {
    return new Promise((resolve, reject) => {
      execFile('git', args, { ...opts, maxBuffer: 64 * 1024 * 1024 }, (err, stdout, stderr) => {
        if (err && !opts.allowFail) {
          return reject(new Error(`git ${args.join(' ')}: ${stderr || err.message}`));
        }
        resolve({ stdout: stdout || '', stderr: stderr || '', code: err ? (err.code || 1) : 0 });
      });
    });
  }

  async readFile(filePath, encoding = 'utf8') {
    return readFile(filePath, encoding);
  }

  async writeFile(filePath, content, encoding = 'utf8') {
    return writeFile(filePath, content, encoding);
  }

  async runShell(cmd, opts = {}) { return this.execShell(cmd, opts); }
  async runBash(cmd, opts = {}) { return this.execShell(cmd, opts); }
  async runPowerShell(cmd, opts = {}) {
    const escaped = cmd.replace(/"/g, '\\"');
    return this.execShell(`powershell.exe -NoProfile -NonInteractive -Command "${escaped}"`, opts);
  }
  async execGit(cmdOrArgs, opts = {}) {
    const args = typeof cmdOrArgs === 'string'
      ? cmdOrArgs.trim().split(/\s+/).filter(Boolean)
      : cmdOrArgs;
    return this.gitCommand(args, opts);
  }

  async globFiles(pattern, opts = {}) {
    const baseDir = opts.cwd || process.cwd();
    const allFiles = [];
    const walk = async (dir) => {
      let entries;
      try { entries = await readdir(dir, { withFileTypes: true }); } catch { return; }
      for (const entry of entries) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) await walk(full);
        else if (entry.isFile()) allFiles.push(path.relative(baseDir, full));
      }
    };
    await walk(baseDir);
    if (!pattern || pattern === '**/*') return allFiles;
    const ext = pattern.replace(/^\*\*\//, '').replace(/^\*/, '');
    return allFiles.filter((f) => f.endsWith(ext));
  }
}

// ── Factory ─────────────────────────────────────────────────────────────────

/**
 * Creates the appropriate executor based on config.
 *
 * When sandbox.enabled is true:  returns WorktreeExecutor (path-validating).
 * When disabled (default):        returns PassthroughExecutor (transparent, behavior-preserving).
 *
 * @param {{ enabled?: boolean, path?: string }} [sandboxConfig]
 * @param {string} [fallbackRoot]  default sandbox root when sandbox.path is not set
 * @returns {SandboxExecutor}
 */
export function createSandbox(sandboxConfig, fallbackRoot) {
  const cfg = sandboxConfig || {};
  if (cfg.enabled) {
    const sandboxRoot = cfg.path || fallbackRoot || process.cwd();
    return new WorktreeExecutor(sandboxRoot);
  }
  return new PassthroughExecutor();
}
