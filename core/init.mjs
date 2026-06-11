#!/usr/bin/env node
/**
 * autopilot/core/init.mjs
 * Universal initialization script — provisions a clean autopilot workspace in any git repo.
 *
 * Usage:
 *   node autopilot/core/init.mjs [target-repo-path] [--dry-run] [--force] [--non-interactive]
 *
 * Flags:
 *   --dry-run           Preview what would be created/written without touching the filesystem
 *   --force             Overwrite existing config.json/state.json if they already exist
 *   --non-interactive   Suppress prompts (same behavior; useful in CI)
 *
 * Exit codes: 0=success, 1=prereq-failure, 2=already-initialized, 3=filesystem-error
 */

import fs from 'fs';
import path from 'path';
import { execSync } from 'child_process';
import { fileURLToPath } from 'url';

// ── CLI argument parsing ──────────────────────────────────────────────────────

const rawArgs = process.argv.slice(2);
const flags = new Set(rawArgs.filter(a => a.startsWith('--')));
const positional = rawArgs.filter(a => !a.startsWith('--'));

const DRY_RUN = flags.has('--dry-run');
const FORCE   = flags.has('--force');

// Default target: the repo root (parent of the autopilot/ dir), or an explicit positional arg.
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const defaultTarget = path.resolve(__dirname, '..', '..');
const targetPath = positional.length > 0 ? path.resolve(positional[0]) : defaultTarget;

// ── Prerequisite checks ───────────────────────────────────────────────────────

/** Validate Node.js is >= the required major version. */
function checkNodeVersion(minMajor = 18) {
  const [, major] = process.version.match(/^v(\d+)/) || [];
  if (!major || Number(major) < minMajor) {
    console.error(`Error: Node.js >= ${minMajor} is required (found ${process.version})`);
    return false;
  }
  return true;
}

/** Check that a CLI tool is available on PATH. */
function checkCommand(cmd) {
  try {
    execSync(`${cmd} --version`, { stdio: 'pipe' });
    return true;
  } catch {
    return false;
  }
}

/** Validate the target path is a git repository. */
function isGitRepo(repoPath) {
  try {
    execSync(`git -C "${repoPath}" rev-parse --git-dir`, { stdio: 'pipe' });
    return true;
  } catch {
    return false;
  }
}

// ── State detection ───────────────────────────────────────────────────────────

/**
 * Returns true when the workspace looks fully initialized (config + state + core dirs present).
 * With --force this returns false so the script overwrites existing config.
 */
function isInitialized(repoPath) {
  if (FORCE) return false;
  const ap = path.join(repoPath, 'autopilot');
  return (
    fs.existsSync(path.join(ap, 'config.json')) &&
    fs.existsSync(path.join(ap, 'state')) &&
    fs.existsSync(path.join(ap, 'state', 'handoff')) &&
    fs.existsSync(path.join(ap, 'inbox'))
  );
}

// ── Directory scaffolding ─────────────────────────────────────────────────────

/** Required autopilot workspace directories (relative to autopilot/). */
const REQUIRED_DIRS = [
  'inbox',
  'inbox/processed',
  'backlog',
  'done',
  'state',
  'state/handoff',
];

function ensureDir(dir) {
  if (DRY_RUN) {
    console.log(`  [dry-run] mkdir -p ${dir}`);
    return;
  }
  try {
    fs.mkdirSync(dir, { recursive: true });
  } catch (err) {
    if (err.code !== 'EEXIST') throw err;
  }
}

// ── Config scaffolding ────────────────────────────────────────────────────────

function buildDefaultConfig() {
  return {
    "provider": "claude",
    "profile": "generic",
    "_profile_comment": "Workspace profile. Set to 'generic' for project-neutral defaults or a custom profile id.",
    "model": "claude-opus-4-7",
    "models": {
      "selector": "claude-haiku-4-5",
      "reviewer": "claude-sonnet-4-6",
      "auditor": "claude-haiku-4-5",
      "architect": "claude-sonnet-4-6",
      "implementerHigh": "claude-opus-4-7",
      "implementerLow": "claude-sonnet-4-6",
      "implementerLowest": "claude-haiku-4-5"
    },
    "implementerRouting": {
      "opusMinRisk": 3,
      "opusKeywords": ["security", "data model", "schema", "migration", "algorithm", "atomic"],
      "_comment": "Risk-aware routing: risk>=opusMinRisk or keyword match → Opus; else Sonnet."
    },
    "paths": {
      "appRoot": ".",
      "appsDir": "apps",
      "functionsDir": "functions",
      "packagesDir": "packages",
      "scriptsDir": "scripts",
      "queues": {
        "inboxDir": "inbox",
        "stateDir": "state",
        "handoffDir": "state/handoff",
        "_comment": "Engine queue/state directories (relative to autopilot/)"
      },
      "_comment": "Root paths for the project (relative to repo root). Edit to match your layout."
    },
    "cli": {
      "bin": "claude",
      "outputFormat": "json",
      "permission": "--dangerously-skip-permissions",
      "timeoutMs": 1800000,
      "maxTurnsPerCall": 60
    },
    "cycle": {
      "maxReviseAttempts": 2,
      "cooldownBetweenCyclesMs": 120000,
      "backlogTopUpThreshold": 4
    },
    "validation": {
      "_comment": "Project-specific validation commands. Replace the empty array with your actual commands.",
      "commands": [],
      "lintRegressionGuard": false,
      "e2e": { "enabled": false }
    },
    "git": {
      "integrationBranch": "autopilot/main",
      "baseBranch": "main",
      "commitPrefix": "kinetic",
      "_comment": "Git targets. integrationBranch is where approved cycles land; baseBranch is the merge target."
    },
    "durationDays": 30,
    "phase": "structure",
    "keyRotation": {
      "enabled": false,
      "maxRetries": 3,
      "defaultCooldownMs": 60000
    },
    "budgetGovernor": {
      "enabled": true,
      "weeklyTokenQuota": null,
      "hardStopFraction": 0.95,
      "downgradeFraction": 0.80,
      "_comment": "Token budget governor (prevents overspend before it happens)"
    },
    "circuitBreaker": {
      "enabled": true,
      "maxConsecutiveFailures": 5,
      "maxConsecutiveRateLimits": 8,
      "_comment": "Engine safety halt (stops if too many consecutive failures)"
    },
    "telemetry": {
      "enabled": false,
      "endpoint": null
    }
  };
}

function buildDefaultState() {
  const now = new Date().toISOString();
  const deadline = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString();
  return {
    "schemaVersion": 2,
    "framework": {
      "version": 1,
      "startedAt": now,
      "deadlineAt": deadline,
      "lastUpdated": now,
      "cycle": 0,
      "status": "ready",
      "goalPhase": "structure",
      "rateLimit": { "pausedUntil": null, "consecutiveHits": 0 },
      "current": null,
      "userTaskSeq": 0,
      "usage": {
        "windowResetAt": now,
        "windowStartedAt": now,
        "lastCycleAt": null,
        "cycles": 0,
        "calls": 0,
        "inputTokens": 0,
        "outputTokens": 0,
        "cacheReadTokens": 0,
        "cacheCreationTokens": 0,
        "costUsd": 0,
        "velocityFactor": 0
      },
      "epics": [],
      "stops": [],
      "budget": {
        "at": now,
        "action": "proceed",
        "reason": "initial state",
        "spent": 0,
        "quota": null,
        "usable": null,
        "projected": 0,
        "estimate": 0,
        "cyclesLeft": null,
        "fractionUsed": 0
      }
    },
    "queues": {
      "inbox": [],
      "backlog": [],
      "done": [],
      "blocked": []
    },
    "tokenSpent": {},
    "_comment": "Empty autopilot workspace initialized by autopilot/core/init.mjs"
  };
}

// ── Main ──────────────────────────────────────────────────────────────────────

async function main() {
  // 1. Prerequisite checks
  if (!checkNodeVersion(18)) process.exit(1);
  if (!checkCommand('git')) {
    console.error('Error: git is not installed or not on PATH');
    process.exit(1);
  }
  if (!checkCommand('npm')) {
    console.error('Error: npm is not installed or not on PATH');
    process.exit(1);
  }

  // 2. Target path validation
  if (!fs.existsSync(targetPath)) {
    console.error(`Error: Target path does not exist: ${targetPath}`);
    process.exit(3);
  }
  if (!isGitRepo(targetPath)) {
    console.error(`Error: Target path is not a git repository: ${targetPath}`);
    console.error(`Hint: run  git init "${targetPath}"  first`);
    process.exit(1);
  }

  // 3. Idempotency check
  if (isInitialized(targetPath)) {
    console.log(`Autopilot workspace already initialized at ${targetPath}`);
    console.log('Use --force to overwrite config.json and state.json.');
    process.exit(0);
  }

  const ap = path.join(targetPath, 'autopilot');
  if (DRY_RUN) {
    console.log(`[dry-run] Would initialize autopilot workspace at: ${targetPath}`);
  } else {
    console.log(`Initializing autopilot workspace at: ${targetPath}`);
  }

  // 4. Create directory structure
  for (const rel of REQUIRED_DIRS) {
    ensureDir(path.join(ap, rel));
  }
  if (!DRY_RUN) console.log('Created autopilot directory structure (inbox, backlog, done, state/handoff)');

  // 5. Scaffold config.json
  const configPath = path.join(ap, 'config.json');
  if (!fs.existsSync(configPath) || FORCE) {
    const config = buildDefaultConfig();
    if (DRY_RUN) {
      console.log(`  [dry-run] write ${configPath}`);
    } else {
      fs.writeFileSync(configPath, JSON.stringify(config, null, 2) + '\n');
      console.log('Generated autopilot/config.json (edit paths and validation.commands for your project)');
    }
  } else {
    console.log('Skipped config.json (already exists; use --force to overwrite)');
  }

  // 6. Scaffold state.json
  const statePath = path.join(ap, 'state', 'state.json');
  if (!fs.existsSync(statePath) || FORCE) {
    const state = buildDefaultState();
    if (DRY_RUN) {
      console.log(`  [dry-run] write ${statePath}`);
    } else {
      fs.writeFileSync(statePath, JSON.stringify(state, null, 2) + '\n');
      console.log('Generated autopilot/state/state.json');
    }
  } else {
    console.log('Skipped state/state.json (already exists; use --force to overwrite)');
  }

  // 7. Create .gitkeep placeholders so empty directories are trackable
  const keepDirs = REQUIRED_DIRS.map(d => path.join(ap, d));
  for (const dir of keepDirs) {
    const kf = path.join(dir, '.gitkeep');
    if (!fs.existsSync(kf)) {
      if (DRY_RUN) {
        console.log(`  [dry-run] touch ${kf}`);
      } else {
        fs.writeFileSync(kf, '');
      }
    }
  }

  if (DRY_RUN) {
    console.log('\n[dry-run] No files were written. Remove --dry-run to apply.');
    process.exit(0);
  }

  console.log('\nAutopilot workspace initialized successfully.');
  console.log('\nNext steps:');
  console.log('  1. Edit autopilot/config.json — set paths.appRoot and validation.commands for your project');
  console.log('  2. Run:  node autopilot/supervisor.mjs init   (seed starter backlog + set deadline)');
  console.log('  3. Run:  node autopilot/supervisor.mjs run    (start the autonomous loop)');
  process.exit(0);
}

main().catch(err => {
  if (err.code === 'EACCES' || err.code === 'EPERM') {
    console.error(`Error: Permission denied — ${err.message}`);
    process.exit(3);
  }
  console.error(`Error: ${err.message}`);
  process.exit(3);
});
