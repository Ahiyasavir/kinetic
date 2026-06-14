#!/usr/bin/env node
// watchdog.mjs — keeps the kinetic supervisor running FOREVER (until you say stop).
//
//   • Restarts the supervisor if it ever exits (crash, OOM, kill).
//   • Exponential backoff if it keeps dying fast, so a broken state can't become a CPU-pegging
//     tight restart loop.
//   • Survives reboots when registered as a logon Scheduled Task (see autopilot/install-service.ps1).
//   • Single watchdog only (atomic lock) — and it clears the supervisor lock before each start, so a
//     hard-killed supervisor's stale lock (or a recycled pid) can never block the restart.
//   • Stops cleanly the instant you run:  node autopilot/supervisor.mjs stop   (writes a STOP flag).
//
// Start it (detached) with autopilot/install-service.ps1, or directly: node autopilot/watchdog.mjs
import { spawn, execFileSync } from 'node:child_process';
import { writeFileSync, readFileSync, existsSync, rmSync, mkdirSync, openSync, closeSync, statSync, renameSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { queuePaths, telemetry as telemetryConfig, telemetryResolvedLine, sandbox as sandboxConfig, sandboxResolvedLine } from './config-loader.mjs';
import { initTelemetry, recordEvent, flushTelemetry } from './lib/telemetry.mjs';
import { lockPaths, locksResolvedLine } from './lib/lock-manager.mjs';
import { gitConfig, gitConfigResolvedLine } from './lib/git-config-loader.mjs';
import * as git from './lib/git.mjs';
import { requireLocalPath, formatEngineError, LockError } from './lib/engine-error.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
// The supervisor's working directory is the config-driven git target (U-35): the configured external
// repository or its managed worktree, resolved by lib/git-config-loader.mjs. Defaults to the repo the
// kinetic lives in, so the current RushPoint layout (no config.git.repository/worktreeName) is
// unchanged. We also export KINETIC_GIT_ROOT so the supervisor consumes the identical resolved path.
const ROOT = gitConfig.cwd;                               // the working-tree root (cwd for the supervisor)
// State dir is config-driven (autopilot/config.json → paths.queues.stateDir, U-31) so the watchdog's
// STOP flag + locks always track the same directory the supervisor uses. Defaults to 'state'.
const STATE_DIR = queuePaths.stateDir;
const SUPERVISOR = path.join(__dirname, 'supervisor.mjs');
const STOP_FLAG = path.join(STATE_DIR, 'STOP');
// Lock basenames are config-driven (config.json → locks, U-32) so concurrent kinetic instances
// against different target repos/goals never share a lock. Resolved by lib/lock-manager.mjs; falls
// back to the legacy 'watchdog.lock'/'supervisor.lock' basenames when config.locks is absent.
const WD_LOCK = lockPaths.watchdog;
const SUP_LOCK = lockPaths.supervisor;
const LOG = path.join(__dirname, 'run.log');

const localTs = () => new Date().toLocaleString('he-IL', { timeZone: 'Asia/Jerusalem', hour12: false,
  year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit' });
const log = (...a) => console.log(`[watchdog ${localTs()}]`, ...a);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const pidAlive = (pid) => { if (!pid) return false; try { process.kill(pid, 0); return true; } catch (e) { return e.code === 'EPERM'; } };
const watchdogStartedAt = Date.now();

// Process-level safety net: catch any unhandled rejections or exceptions that escape from main().
// This ensures even catastrophic errors are logged with full context instead of crashing silently.
const globalErrorHandler = (err) => {
  const elapsedMs = Date.now() - watchdogStartedAt;
  const errorOutput = (err && err.code) ? formatEngineError(err, { elapsedMs, activeStep: 'process-error' }) : '';
  log(errorOutput || `FATAL UNHANDLED ERROR: ${err.stack || err.message}`);
  process.exit(1);
};
process.on('unhandledRejection', (reason) => {
  const err = reason instanceof Error ? reason : new Error(String(reason));
  globalErrorHandler(err);
});
process.on('uncaughtException', (err) => {
  globalErrorHandler(err);
});

mkdirSync(STATE_DIR, { recursive: true });

// ---- single-watchdog lock (atomic O_EXCL, with stale reclaim) ----
function acquireWatchdogLock() {
  for (let i = 0; i < 2; i++) {
    try { const fd = openSync(WD_LOCK, 'wx'); writeFileSync(fd, JSON.stringify({ pid: process.pid })); closeSync(fd); return true; }
    catch (e) {
      if (e.code !== 'EEXIST') {
        throw new LockError(
          `Watchdog failed to acquire its lock at "${WD_LOCK}": ${e.message}. ` +
          `This is likely a permissions issue or the lock file is on a read-only filesystem.`,
          { cause: e }
        );
      }
      let prev = {}; try { prev = JSON.parse(readFileSync(WD_LOCK, 'utf8')); } catch {}
      if (prev.pid && prev.pid !== process.pid && pidAlive(prev.pid)) { log(`another watchdog is running (pid ${prev.pid}) — exiting.`); return false; }
      try { rmSync(WD_LOCK); } catch {}
    }
  }
  return false;
}
function releaseWatchdogLock() { try { const l = JSON.parse(readFileSync(WD_LOCK, 'utf8')); if (l.pid === process.pid) rmSync(WD_LOCK); } catch {} }

// ---- rotate run.log if it grows large (keep one .1 backup) so a multi-day run can't fill the disk ----
function rotateLogIfBig() {
  try { if (existsSync(LOG) && statSync(LOG).size > 25 * 1024 * 1024) { renameSync(LOG, LOG + '.1'); } } catch {}
}

// ---- auto-sync the kinetic engine repo to GitHub after each supervisor run ----
// Commits any engine file changes (supervisor.mjs, lib/*, etc.) and pushes to the
// kinetic remote so collaborators always see the latest version. No-op when the
// autopilot/ directory has no .git or no changes.
function syncKineticRepo() {
  if (!existsSync(path.join(__dirname, '.git'))) return;
  try {
    // Sandbox exemption: these execFileSync calls operate on __dirname (the kinetic engine's
    // own repository, not any tenant worktree). They are engine infrastructure — syncing the
    // autopilot source itself to GitHub — and do not execute untrusted tenant code. Sandbox
    // isolation (U-62) guards tenant worktree access; the engine's self-maintenance is exempt.
    const status = execFileSync('git', ['-C', __dirname, 'status', '--porcelain'], { encoding: 'utf8' }).trim();
    if (!status) return;
    execFileSync('git', ['-C', __dirname, 'add', '-A'], { encoding: 'utf8' }); // exempt: engine repo, not tenant
    execFileSync('git', ['-C', __dirname, 'commit', '-m', 'engine: auto-sync'], { encoding: 'utf8' }); // exempt: engine repo, not tenant
    execFileSync('git', ['-C', __dirname, 'push', 'origin', 'main'], { encoding: 'utf8', timeout: 30000 }); // exempt: engine repo, not tenant
    log('kinetic repo: changes pushed to GitHub.');
  } catch (e) {
    log('kinetic repo: sync skipped (non-fatal):', e.message?.split('\n')[0] || e.message);
  }
}

async function main() {
  if (!acquireWatchdogLock()) process.exit(0);
  // clean shutdown of OUR lock
  for (const sig of ['exit', 'SIGINT', 'SIGTERM']) process.on(sig, releaseWatchdogLock);

  // Respect a STANDING stop: if the user ran `supervisor.mjs stop`, stay down — even across reboots
  // (the logon task will keep hitting this and exiting) — until they explicitly run `start` again.
  if (existsSync(STOP_FLAG)) { log('STOP flag is set (kinetic was stopped by the user) — not starting. Run `node autopilot/supervisor.mjs start` to resume.'); process.exit(0); }

  // Decoupled engine telemetry (U-36): the watchdog reports its own supervision health independently of
  // the product. Disabled by default → recorders no-op, so this never alters restart behavior.
  initTelemetry(telemetryConfig);
  recordEvent('watchdog-start', { pid: process.pid });
  log(telemetryResolvedLine());
  log(locksResolvedLine());
  log(gitConfigResolvedLine());
  // Sandbox isolation config (U-62): watchdog logs the sandbox seam state so startup
  // confirms whether enforcement is active or passthrough mode is in effect.
  log(sandboxResolvedLine());
  // U-35: if a dedicated worktree is configured, ensure it exists before the supervisor starts so the
  // engine always has its target checkout ready. No-op for the default in-place RushPoint layout.
  if (gitConfig.worktreeName) {
    try {
      const created = await git.ensureWorktree(
        gitConfig.repository, gitConfig.worktreePath, gitConfig.branch, gitConfig.baseBranch);
      log(`git worktree ${created ? 'created' : 'present'} at ${gitConfig.worktreePath} (branch ${gitConfig.branch})`);
    } catch (e) { log('worktree init failed (continuing in-place):', e.message); }
  }
  // The supervisor entry-point is the one local code path the watchdog cannot run without. If it is
  // missing, retrying the spawn forever only yields cryptic ENOENT spawn errors — so fail fast with a
  // descriptive engine-level exception (surfaced by main().catch below) instead.
  requireLocalPath(SUPERVISOR, 'supervisor entry-point');
  log(`watching ${SUPERVISOR}`);
  let fails = 0; // consecutive fast failures → backoff

  while (true) {
    if (existsSync(STOP_FLAG)) { log('STOP flag present — shutting down.'); break; }

    // We are the sole launcher: a leftover supervisor lock here is always stale → clear it so the
    // restart never gets refused by a dead/recycled pid.
    if (existsSync(SUP_LOCK)) {
      let owner = 0; try { owner = JSON.parse(readFileSync(SUP_LOCK, 'utf8')).pid; } catch {}
      if (!pidAlive(owner)) { try { rmSync(SUP_LOCK); } catch {} }
      else { log(`a supervisor (pid ${owner}) is already running — not double-starting; waiting.`); await sleep(15000); continue; }
    }

    rotateLogIfBig();
    const startedAt = Date.now();
    recordEvent('watchdog-tick', { fails, ts: startedAt });
    await flushTelemetry();
    log('starting supervisor…');

    const code = await new Promise((resolve) => {
      // append supervisor output to run.log
      const out = openSync(LOG, 'a');
      const child = spawn(process.execPath, [SUPERVISOR, 'run'], {
        cwd: ROOT,
        // Pass the resolved git working-tree root so the supervisor's git.* operations target the
        // exact same repository/worktree the watchdog initialized (U-35).
        env: { ...process.env, KINETIC_GIT_ROOT: ROOT },
        stdio: ['ignore', out, out]
      });
      child.on('exit', (c) => { try { closeSync(out); } catch {} resolve(c ?? 0); });
      child.on('error', (e) => { try { closeSync(out); } catch {} log('spawn error:', e.message); resolve(1); });
    });

    if (existsSync(STOP_FLAG)) { log('STOP flag present after supervisor exit — shutting down.'); break; }

    syncKineticRepo();
    const ranMs = Date.now() - startedAt;
    if (code !== 0) recordEvent('error', { kind: 'supervisor-exit', code, ranMs });
    if (ranMs < 30000) fails++; else fails = 0;       // only "fast" deaths count toward backoff
    const backoff = Math.min(15000 * Math.pow(2, Math.max(0, fails - 1)), 10 * 60 * 1000); // 15s → 10min cap
    log(`supervisor exited (code ${code}) after ${Math.round(ranMs / 1000)}s. Restarting in ${Math.round(backoff / 1000)}s (consecutive fast fails: ${fails}).`);
    await sleep(backoff);
  }

  log('watchdog stopped.');
  process.exit(0);
}

// Guard: only run the watchdog loop when invoked directly (not when imported by tests).
// Sandbox (U-62): this guard enables safe import() of watchdog.mjs in test environments.
const isDirectRun = path.resolve(process.argv[1] || '') === fileURLToPath(import.meta.url);
if (isDirectRun) {
  main().catch((e) => {
    const elapsedMs = Date.now() - watchdogStartedAt;
    const errorOutput = (e && e.code) ? formatEngineError(e, { elapsedMs, activeStep: 'watchdog-startup' }) : '';
    log(errorOutput || `fatal: ${e.stack || e.message}`);
    process.exit(1);
  });
}
