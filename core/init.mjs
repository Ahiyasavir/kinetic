#!/usr/bin/env node
/**
 * autopilot/core/init.mjs
 * Universal initialization script for provisioning clean autopilot workspaces.
 *
 * Usage: node autopilot/core/init.mjs <target-repo-path>
 * Exit codes: 0=success, 1=not-a-git-repo, 2=already-initialized, 3=permission-error
 */

import fs from 'fs';
import path from 'path';
import { execSync } from 'child_process';

const args = process.argv.slice(2);

if (args.length === 0) {
  console.error('Usage: node autopilot/core/init.mjs <target-repo-path>');
  process.exit(1);
}

const targetPath = path.resolve(args[0]);

// Validate target is a git repository
function validateGitRepo(repoPath) {
  try {
    execSync(`git -C "${repoPath}" rev-parse --git-dir`, { stdio: 'pipe' });
    return true;
  } catch {
    return false;
  }
}

// Check if workspace is already initialized
function isInitialized(repoPath) {
  const autopilotDir = path.join(repoPath, 'autopilot');
  const configPath = path.join(autopilotDir, 'config.json');
  const statePath = path.join(autopilotDir, 'state.json');
  const queuesPath = path.join(autopilotDir, 'queues');

  return fs.existsSync(configPath) &&
         fs.existsSync(statePath) &&
         fs.existsSync(queuesPath);
}

// Create directory structure
function createDirectories(repoPath) {
  const autopilotDir = path.join(repoPath, 'autopilot');
  const dirs = [
    path.join(autopilotDir, 'queues', 'inbox'),
    path.join(autopilotDir, 'queues', 'backlog'),
    path.join(autopilotDir, 'queues', 'done'),
    path.join(autopilotDir, 'state'),
    path.join(repoPath, '.claude')
  ];

  for (const dir of dirs) {
    try {
      fs.mkdirSync(dir, { recursive: true });
    } catch (err) {
      if (err.code !== 'EEXIST') {
        throw err;
      }
    }
  }
}

// Generate default config.json
function generateDefaultConfig() {
  return {
    "provider": "claude",
    "profile": "generic",
    "_profile_comment": "Workspace profile (autopilot/profiles/<profile>.json). Set to 'generic' for project-neutral defaults or a custom profile id.",
    "model": "claude-opus-4-8",
    "architectModel": "claude-fable-5",
    "architect": {
      "enabled": true,
      "autoTrigger": true,
      "minTasks": 20,
      "maxTasks": 40
    },
    "api_pools": [],
    "_keyRotation_comment": "API key rotation tuning. maxRetries = key rotations per call before error; defaultCooldownMs = fallback cooldown.",
    "keyRotation": {
      "enabled": true,
      "maxRetries": 3,
      "defaultCooldownMs": 60000,
      "providerMap": { "claude": "anthropic" }
    },
    "models": {
      "selector": "claude-haiku-4-5",
      "reviewer": "claude-sonnet-4-6",
      "auditor": "claude-haiku-4-5",
      "architect": "claude-fable-5",
      "implementerHigh": "claude-opus-4-8",
      "implementerLow": "claude-sonnet-4-6",
      "implementerLowest": "claude-haiku-4-5"
    },
    "implementerRouting": {
      "opusMinRisk": 3,
      "opusKeywords": [
        "security", "firestore.rules", "data model", "schema", "migration",
        "scoring", "algorithm", "atomic", "transaction", "auth"
      ],
      "_comment": "Risk-aware routing: risk>=3 or opusKeyword → Opus; else Sonnet."
    },
    "scoring": {
      "weights": {
        "userImpact": 5,
        "adminImpact": 3,
        "reliability": 3,
        "productRisk": 2,
        "cleanupValue": 1
      },
      "categoryBonus": {
        "builder": 9,
        "admin": 9,
        "gameplay": 6,
        "ui": 6,
        "reliability": 1,
        "structure": 0
      },
      "minProductShare": 0.7,
      "minProductTasks": 5,
      "maxAttemptsBeforeBlock": 3,
      "maxReviewFailAttempts": 2
    },
    "durationDays": 3650,
    "phase": "structure",
    "paths": {
      "appRoot": ".",
      "appsDir": "apps",
      "functionsDir": "functions",
      "packagesDir": "packages",
      "scriptsDir": "scripts",
      "queues": {
        "inboxDir": "autopilot/queues/inbox",
        "stateDir": "autopilot/queues",
        "backlogDir": "autopilot/queues/backlog",
        "doneDir": "autopilot/queues/done",
        "handoffDir": "autopilot/state/handoff",
        "_comment": "Engine queue/state directories (resolved relative to appRoot)"
      },
      "_comment": "Root paths for the project (resolved relative to repo root). Edit these to onboard a different project layout."
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
    "rateLimit": {
      "baseCooldownMs": 1200000,
      "maxCooldownMs": 2700000
    },
    "taskClasses": {
      "default": "product",
      "map": {},
      "policy": {}
    },
    "budgetGovernor": {
      "enabled": true,
      "weeklyTokenQuota": null,
      "reserveFraction": 0.10,
      "safetyMargin": 0.15,
      "retryBuffer": 1.50,
      "hardStopFraction": 0.95,
      "downgradeFraction": 0.80,
      "minCycleTokens": 50000,
      "safeMode": true,
      "safeReserveFraction": 0.25,
      "safeDowngradeFraction": 0.50,
      "safeHardStopFraction": 0.75,
      "_comment": "Token budget governor (prevents overspend before it happens)"
    },
    "circuitBreaker": {
      "enabled": true,
      "maxConsecutiveFailures": 5,
      "maxConsecutiveRateLimits": 8,
      "maxConsecutiveUnproductive": 12,
      "maxWindowCostUsd": null,
      "_comment": "Engine safety halt (stops if too many failures or rate limits)"
    },
    "weeklyBudget": {
      "enabled": true,
      "resetAt": new Date().toISOString(),
      "resetIntervalDays": 7,
      "maxCyclesPerDay": 30,
      "velocitySensitivity": 1.0,
      "_comment": "Weekly usage pacing"
    },
    "budgets": {
      "_comment": "Per-project token budgets (key = projectId)"
    },
    "validation": {
      "_comment": "Project-specific validation commands. Edit this array to add typecheck/build/lint/e2e.",
      "commands": [],
      "lintRegressionGuard": false,
      "e2e": { "enabled": false }
    },
    "telemetry": {
      "enabled": false,
      "endpoint": null,
      "batchSize": 50,
      "flushIntervalMs": 60000,
      "_comment": "Engine telemetry (reports autopilot health independently)"
    },
    "git": {
      "integrationBranch": "autopilot/init",
      "baseBranch": "main",
      "commitPrefix": "autopilot",
      "_comment": "Git targets. integrationBranch and baseBranch are required; baseBranch is the default merge target."
    }
  };
}

// Generate default state.json (empty framework state)
function generateDefaultState() {
  const now = new Date().toISOString();
  const deadline = new Date(Date.now() + 3650 * 24 * 60 * 60 * 1000).toISOString();

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
      "rateLimit": {
        "pausedUntil": null,
        "consecutiveHits": 0
      },
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

// Main execution
async function main() {
  // Validate target path exists and is accessible
  if (!fs.existsSync(targetPath)) {
    console.error(`Error: Target path does not exist: ${targetPath}`);
    process.exit(3);
  }

  // Validate it's a git repository
  if (!validateGitRepo(targetPath)) {
    console.error(`Error: Target path is not a git repository: ${targetPath}`);
    console.error('Use: git init ' + targetPath);
    process.exit(1);
  }

  // Check if already initialized (idempotent)
  if (isInitialized(targetPath)) {
    console.log(`✓ Workspace already initialized at ${targetPath}`);
    process.exit(0);
  }

  try {
    // Create directory structure
    createDirectories(targetPath);
    console.log('✓ Created autopilot directory structure');

    // Write config.json (only if doesn't exist)
    const autopilotDir = path.join(targetPath, 'autopilot');
    const configPath = path.join(autopilotDir, 'config.json');
    if (!fs.existsSync(configPath)) {
      fs.writeFileSync(
        configPath,
        JSON.stringify(generateDefaultConfig(), null, 2)
      );
      console.log('✓ Generated autopilot/config.json');
    }

    // Write state.json (only if doesn't exist)
    const statePath = path.join(autopilotDir, 'state.json');
    if (!fs.existsSync(statePath)) {
      fs.writeFileSync(
        statePath,
        JSON.stringify(generateDefaultState(), null, 2)
      );
      console.log('✓ Generated autopilot/state.json');
    }

    // Create empty .gitkeep files in queue directories to ensure they're tracked
    const keepDirs = [
      path.join(autopilotDir, 'queues', 'inbox'),
      path.join(autopilotDir, 'queues', 'backlog'),
      path.join(autopilotDir, 'queues', 'done'),
      path.join(autopilotDir, 'state')
    ];
    for (const dir of keepDirs) {
      const keepFile = path.join(dir, '.gitkeep');
      if (!fs.existsSync(keepFile)) {
        fs.writeFileSync(keepFile, '');
      }
    }
    console.log('✓ Created .gitkeep files in queue directories');

    console.log(`\n✓ Autopilot workspace initialized successfully at ${targetPath}`);
    console.log('\nNext steps:');
    console.log('  1. Edit autopilot/config.json to customize paths and settings');
    console.log('  2. Select a profile: set config.profile to "generic" or create a custom profile');
    console.log('  3. Run: npm run supervisor (or the autopilot supervisor command)');
    process.exit(0);
  } catch (err) {
    if (err.code === 'EACCES' || err.code === 'EPERM') {
      console.error(`Error: Permission denied creating directories: ${err.message}`);
      process.exit(3);
    }
    console.error(`Error initializing workspace: ${err.message}`);
    process.exit(3);
  }
}

main();
