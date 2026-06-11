#!/usr/bin/env node
// supervisor.mjs — RushPoint Kinetic: a persistent external supervisor that runs Claude Opus 4.8 in
// repeated work cycles for five days. It selects the next task, has one agent implement it and another
// review it, validates, persists progress, pauses on rate limits, and resumes from disk after restart.
//
// Usage:
//   node autopilot/supervisor.mjs init     # seed state/ + starter backlog, set the 5-day deadline
//   node autopilot/supervisor.mjs run      # start / resume the autonomous loop (same command)
//   node autopilot/supervisor.mjs status   # print a snapshot without touching the loop

import { readFile, writeFile } from 'node:fs/promises';
import { existsSync, readFileSync, readdirSync, statSync, rmSync } from 'node:fs';
import {
  computeVelocityFactor, effectivePerDay, extractKeywords, bestLessonMatch, loadLessons, saveLessons
} from './lib/learn.mjs';
import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  GOAL_PHASES, emptyState, initState, loadState, saveState, ensureDirs,
  nextTaskId, isPastDeadline, nowIso, seedBacklog
} from './lib/state.mjs';
import { runClaude, RateLimitError } from './lib/claude.mjs';
import { pickImplementerModel, pickRevisionModel } from './lib/route.mjs';
import { rankBacklog, scoreTask, isCleanup, isProduct, productShare, effectiveTaskPriority, loadScoringPlugin } from './lib/score.mjs';
import { selectablePool } from './lib/priority.mjs';
import { isMacroVision, buildArchitectVars, normalizeArchitectPlan, applyArchitectPlanToState, ARCHITECT_MIN_TASKS, ARCHITECT_MAX_TASKS } from './lib/architect.mjs';
import * as git from './lib/git.mjs';
import { runValidation, countLintErrors } from './lib/validate.mjs';
import { runAutoFixes } from './lib/auto-fix.mjs';
import { writeMirrors, appendDecision, ensureDecisionLogHeader } from './lib/files.mjs';
import { ingestInbox, addInboxTask, ensureInbox } from './lib/inbox.mjs';
import { snapshotProtected, frozenProtectedFiles } from './lib/protect.mjs';
import { createCore } from './core/index.mjs';
import { runPostMortem } from './core/post-mortem.mjs';
import { queuePathsResolvedLine, budgetsResolvedLine, telemetry as telemetryConfig, telemetryResolvedLine, apiPools, keyRotation, keyRotationActive, apiPoolsResolvedLine } from './config-loader.mjs';
import { createKeyManager, makeRotatingRun } from './lib/key-manager.mjs';
import { initTelemetry, recordEvent, flushTelemetry, getTelemetryState } from './lib/telemetry.mjs';
import { locksResolvedLine } from './lib/lock-manager.mjs';
import { gitConfigResolvedLine } from './lib/git-config-loader.mjs';
import { contextualName, contextId, handoffResolvedLine } from './lib/handoff-paths.mjs';
import { validateHandoffSchema, handoffSchemaResolvedLine } from './lib/handoff-schema.mjs';
import { countTokens } from './lib/token-counter.mjs';
import { isWithinBudget, budgetTokenCap, projectBudget } from './lib/token-pacer.mjs';
import { EngineError, LockError, OperationalError, requireLocalPath, asEngineError, formatEngineError } from './lib/engine-error.mjs';
import { ensureBreaker, isTripped, recordCycleOutcome, checkCostCeiling, tripBreaker, resetBreaker } from './lib/circuit-breaker.mjs';
import { classifyTask, reviewPolicy } from './lib/task-class.mjs';
import { checkEvidence } from './lib/evidence.mjs';
import { analyzeState, applyReconciliation, formatReport } from './lib/reconcile.mjs';
import { governCycle, detectQuotaMode } from './lib/budget-governor.mjs';
import { getAdapter } from './lib/providers/index.mjs';
import { resolveModelForRole } from './core/providers.mjs';
import { nonLlmAudit } from './lib/verify.mjs';
// Intelligence Efficiency Layer (P1–P3) — deterministic helpers layered on top of the existing systems.
import { compileContext, contextHintBlock } from './lib/context-compiler.mjs';
import { buildDependencyGraph } from './core/dependencies.mjs';
import { selectorFingerprint, getCachedDecision, putCachedDecision, cacheHitRate } from './lib/fingerprint-cache.mjs';
import { recordCycleCost, improvedEstimate, costKey } from './lib/cost-learning.mjs';
// Multi-workspace foundation: the active workspace bundles root + state/queue/lock/budget/validation
// scope; the default workspace equals the engine's existing resolved values (behavior-preserving).
import { resolveActiveWorkspace } from './lib/workspace-registry.mjs';
import { describeWorkspace, assertWithinBoundary } from './lib/workspace.mjs';
import { compileFilters } from './lib/workspace-profile.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '..');
const supervisorStartedAt = Date.now();

// Process-level safety net: catch any unhandled rejections or exceptions that escape from the main loop.
// This ensures even catastrophic errors are logged with full context instead of crashing silently.
const globalErrorHandler = (err) => {
  const elapsedMs = Date.now() - supervisorStartedAt;
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

// AIMD adaptive interval constants (TCP-style self-tuning rate control).
// On success: shrink the gap by 10% (additive increase toward minimum).
// On rate-limit: double the gap (multiplicative decrease away from the limit).
const ADAPTIVE_INITIAL_MS = 5 * 60 * 1000;  // 5 min starting gap
const ADAPTIVE_MIN_MS     = 1 * 60 * 1000;  // 1 min floor
const ADAPTIVE_MAX_MS     = 60 * 60 * 1000; // 60 min ceiling
// ── ACTIVE WORKSPACE (multi-workspace foundation) ──────────────────────────
// Every per-target runtime fact (operating root, state dir, queues, locks, STOP flag, budget scope,
// validation) now flows from ONE Workspace object instead of five separate config singletons. The
// DEFAULT workspace is constructed to EQUAL the engine's existing resolved values (gitConfig.cwd,
// queuePaths.*, lockPaths.*, repoGoal, the configured validation), so the default run is byte-identical
// — only an explicitly-selected named workspace (KINETIC_WORKSPACE / workspaces.json) gets isolated
// dirs. The watchdog's KINETIC_GIT_ROOT still overrides the default workspace's operating root.
const { workspace: WORKSPACE, registry: WORKSPACE_REGISTRY } = resolveActiveWorkspace({
  envId: process.env.KINETIC_WORKSPACE, gitRootOverride: process.env.KINETIC_GIT_ROOT,
});
const GIT_ROOT = WORKSPACE.root;                                  // working dir for git/validation ops
const STATE_DIR = WORKSPACE.stateDir;                             // isolated per workspace
const HANDOFF_DIR = WORKSPACE.queuePaths.handoffDir;
const STATE_PATH = WORKSPACE.statePath;
const LESSONS_PATH = WORKSPACE.queuePaths.lessonsPath;
// P5 — persistent validation cache file (survives restarts; auto-invalidated by tree-signature+config).
const VALIDATION_CACHE_PATH = WORKSPACE.queuePaths.validationCacheFile;
const PROMPT_DIR = path.join(__dirname, 'prompts');               // engine-shared (NOT per-workspace)
const INBOX_DIR = WORKSPACE.queuePaths.inboxDir;
const LOCK_PATH = WORKSPACE.lockPaths.supervisor;
const WD_LOCK_PATH = WORKSPACE.lockPaths.watchdog;
const STOP_FLAG = WORKSPACE.queuePaths.stopFlag;
// Config-driven display path for the per-role handoff JSON the Claude agents are told to write, so
// the prompt instructions track a customized handoffDir (defaults to 'autopilot/state/handoff'). The
// basename is context-tagged (U-34, lib/handoff-paths.mjs) so concurrent project contexts that share a
// handoff dir never collide — and it matches what core's readHandoff (resolveName) reads back.
const handoffRel = (file) => path.join(path.relative(REPO_ROOT, HANDOFF_DIR), contextualName(file)).replaceAll('\\', '/');

const CONFIG_PATH = path.join(__dirname, 'config.json');
// Read the engine config up front. A missing/unreadable config is an ENGINE fault (a missing local code
// path), so surface it as a descriptive EngineError rather than a bare ENOENT or JSON parse stack.
const config = await (async () => {
  let raw;
  try { raw = await readFile(CONFIG_PATH, 'utf8'); }
  catch (e) { throw asEngineError(e, 'config file', CONFIG_PATH); }
  try { return JSON.parse(raw); }
  catch (e) { throw new EngineError(`Kinetic engine config is not valid JSON: "${CONFIG_PATH}" (${e.message}).`, { code: 'ENGINE_BAD_CONFIG', path: CONFIG_PATH, cause: e }); }
})();

// The isolated token-budget namespace for THIS workspace (U-33). Token tracking + budget pacing are
// keyed by this scope so concurrent workspaces keep wholly independent counters
// (state.tokenSpent[PROJECT_ID]) and budgets (config.budgets[PROJECT_ID]). = WORKSPACE.budgetScope,
// which equals the config-derived repoGoal for the default workspace (unchanged) and the workspace id
// for a named one.
const PROJECT_ID = WORKSPACE.budgetScope;
// Validation is workspace-scoped: a named workspace brings its own commands (or a safe empty set), so
// we never run one workspace's toolchain against another's repo. For the default workspace this is the
// engine's configured validation — identical to config.validation. Engine guardrails (syntax /
// protected-core in validate.mjs) run regardless of this set.
const wsConfig = { ...config, validation: WORKSPACE.validation };

// Plugin scoring (U-44): load the optional scoring plugin declared in config.scoring.plugin.
// No-op when the key is absent; non-fatal on missing file so the engine doesn't stall on startup.
await loadScoringPlugin(config, __dirname).catch(() => {});

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const localTs = () => new Date().toLocaleString('he-IL', { timeZone: 'Asia/Jerusalem', hour12: false,
  year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit' });
const log = (...a) => console.log(`[kinetic ${localTs()}]`, ...a);

function fmtTasks(tasks, max = 30) {
  if (!tasks.length) return '(none)';
  return tasks.slice(0, max).map((t) =>
    `- ${t.id} [${t.goal}] ${t.title} (risk ${t.risk}/effort ${t.effort})` +
    (t.blockReason ? ` — blocked: ${t.blockReason}` : '')
  ).join('\n');
}

// Normalize the 5 scoring dimensions coming from the selector (clamped 0–5).
function normDims(d) {
  const g = (k) => Math.max(0, Math.min(5, Number((d || {})[k]) || 0));
  return {
    userImpact: g('userImpact'), adminImpact: g('adminImpact'), reliability: g('reliability'),
    productRisk: g('productRisk'), cleanupValue: g('cleanupValue')
  };
}

// Ranked candidate list (with scores + one-line reasons) for the cycle log and the selector prompt.
function fmtRanked(ranked, max = 12) {
  return ranked.slice(0, max).map((x, i) =>
    `${i + 1}. ${x.task.id} ${x.task.userRequested ? '★[USER REQUEST — MUST PICK FIRST]' : `[${x.cleanup ? 'cleanup' : 'product'}]`} score=${x.total} — ${x.task.title}\n` +
    `     why: ${x.task.userRequested ? 'the user explicitly asked for this' : x.reason}` + (x.task.risk ? ` · risk ${x.task.risk}/5 effort ${x.task.effort}/5` : '')
  ).join('\n');
}

// Auto-drop guard: the selector occasionally proposes "build feature X" for an X that already ships
// on this branch. The quality gates would catch it, but that wastes cycles — so we reject obvious
// rebuilds up front. A title is a rebuild if it names a shipped feature WITHOUT a polish/improve intent.
// PROJECT-NEUTRAL: the rebuild / UI-freeze patterns are no longer hardcoded here — they come from the
// active workspace PROFILE (compiled from regex sources in profiles/<id>.json). looksLikeRebuild drops
// a proposed task that names an already-shipped feature without a polish intent; looksLikeUiOrFeature
// (used only when the profile opts into a hardening freeze) drops cosmetic/new-feature work. A profile
// with no patterns (the generic default) is permissive — the real quality gates still apply.
const FILTERS = compileFilters(WORKSPACE.profile);
const looksLikeRebuild = FILTERS.looksLikeRebuild;
const looksLikeUiOrFeature = FILTERS.looksLikeUiOrFeature;

// Near-duplicate detection: the selector sometimes proposes a task that is essentially one already in
// the backlog/done (e.g. "Event-day readiness page …" twice with different wording). Exact-title dedup
// misses these; compare normalized significant-token sets instead.
const TITLE_STOP = new Set(['the', 'and', 'for', 'with', 'that', 'from', 'this', 'your', 'via', 'add', 'new', 'show', 'are', 'all', 'can', 'not', 'into', 'when', 'each', 'they', 'them']);
function titleTokens(s) {
  return new Set(String(s || '').toLowerCase().split(/[^a-z0-9]+/).filter((w) => w.length > 2 && !TITLE_STOP.has(w)));
}
function titlesNearDuplicate(a, b) {
  const A = titleTokens(a), B = titleTokens(b);
  if (A.size < 3 || B.size < 3) return false;
  let inter = 0; for (const w of A) if (B.has(w)) inter++;
  return inter / Math.min(A.size, B.size) >= 0.6;
}

// ---------- weekly usage self-metering ----------
// The core role runner reports usage via the injected onUsage hook (recordUsage) without a `state`
// handle, so per-call usage accumulates here and runCycle folds the cycle's total into state.usage on
// success (see the main loop).
let _cycleUsage = null;
function resetCycleUsage() {
  _cycleUsage = { calls: 0, inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheCreationTokens: 0, costUsd: 0 };
}
function recordUsage(res) {
  if (!_cycleUsage) resetCycleUsage();
  const u = res?.usage || {};
  _cycleUsage.calls += 1;
  _cycleUsage.inputTokens += Number(u.input_tokens || 0);
  _cycleUsage.outputTokens += Number(u.output_tokens || 0);
  _cycleUsage.cacheReadTokens += Number(u.cache_read_input_tokens || 0);
  _cycleUsage.cacheCreationTokens += Number(u.cache_creation_input_tokens || 0);
  if (typeof res?.costUsd === 'number') _cycleUsage.costUsd += res.costUsd;
}
function ensureUsage(state) {
  if (!state.usage) {
    state.usage = {
      windowResetAt: null, windowStartedAt: null, lastCycleAt: null, velocityFactor: 1.0,
      cycles: 0, calls: 0, inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheCreationTokens: 0, costUsd: 0,
      adaptiveIntervalMs: ADAPTIVE_INITIAL_MS
    };
  }
  if (!state.usage.adaptiveIntervalMs) state.usage.adaptiveIntervalMs = ADAPTIVE_INITIAL_MS;
  return state.usage;
}
function decreaseAdaptiveInterval(state) {
  const u = ensureUsage(state);
  u.adaptiveIntervalMs = Math.max(ADAPTIVE_MIN_MS, Math.round(u.adaptiveIntervalMs * 0.90));
}
function increaseAdaptiveInterval(state) {
  const u = ensureUsage(state);
  u.adaptiveIntervalMs = Math.min(ADAPTIVE_MAX_MS, u.adaptiveIntervalMs * 2);
}
function foldCycleUsage(state) {
  const u = ensureUsage(state);
  if (!_cycleUsage) return;
  u.calls += _cycleUsage.calls;
  u.inputTokens += _cycleUsage.inputTokens;
  u.outputTokens += _cycleUsage.outputTokens;
  u.cacheReadTokens += _cycleUsage.cacheReadTokens;
  u.cacheCreationTokens += _cycleUsage.cacheCreationTokens;
  u.costUsd += _cycleUsage.costUsd;
  // Per-project token accounting (U-33): route the cycle's tokens (covers every role incl. the
  // implementer) through the pure counter so spend stays isolated under state.tokenSpent[PROJECT_ID].
  const cycleTokens = _cycleUsage.inputTokens + _cycleUsage.outputTokens;
  state.tokenSpent = countTokens(PROJECT_ID, cycleTokens, state).tokenSpent;
  _cycleUsage = null;
}

// Tokens consumed by the in-flight cycle so far (input+output), read before foldCycleUsage clears the
// per-cycle tally. Used to stamp the engine telemetry cycle-end event.
function currentCycleTokens() {
  return _cycleUsage ? (_cycleUsage.inputTokens + _cycleUsage.outputTokens) : 0;
}

// Mirror the decoupled engine-telemetry buffer onto state so saveState persists it under the FRAMEWORK
// tier (state.json → '.framework.telemetry'), kept separate from the target-app state (U-36). No-op for
// persistence cost when telemetry is disabled (the buffer stays empty).
function syncTelemetry(state) {
  state.telemetry = getTelemetryState();
}

// ---------- local dep-graph context maps (activates the U-45 dep-graph filter in runSelector) ----------
// Scans the kinetic's own source tree (autopilot/lib, autopilot/core) for .mjs files, builds a
// dependency graph, and wraps it in a ContextMaps envelope so runSelector's dep-graph filter can
// prune the engine-file context to only what's relevant to the current candidate tasks. No-op cost
// when zero files are found (early-return). Cached process-lifetime (the kinetic's own source is
// stable within a run).
let _localContextMaps = null;
function buildLocalContextMaps() {
  if (_localContextMaps) return _localContextMaps;
  const scanDirs = [path.join(__dirname, 'lib'), path.join(__dirname, 'core')];
  const fileMap = {};
  const walk = (dir) => {
    let entries; try { entries = readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      const full = path.join(dir, e.name);
      if (e.isDirectory() && !['node_modules', '.git', 'state'].includes(e.name)) { walk(full); continue; }
      if (e.isFile() && /\.(mjs|js|cjs)$/.test(e.name)) {
        const rel = path.relative(__dirname, full).replaceAll('\\', '/');
        try { fileMap[rel] = readFileSync(full, 'utf8'); } catch { fileMap[rel] = null; }
      }
    }
  };
  for (const d of scanDirs) walk(d);
  if (!Object.keys(fileMap).length) return null;
  const depGraph = buildDependencyGraph(fileMap);
  const fileIndex = {};
  for (const rel of Object.keys(fileMap)) {
    try { fileIndex[rel] = { size: statSync(path.join(__dirname, rel)).size, lang: 'js' }; } catch { fileIndex[rel] = {}; }
  }
  _localContextMaps = { fileIndex, symbolIndex: {}, dependencyGraph: depGraph, generatedAt: Date.now(), source: 'kinetic-local' };
  log(`Local context maps: ${Object.keys(fileIndex).length} engine files indexed for dep-graph filter.`);
  return _localContextMaps;
}

// ---------- core engine wiring ----------
// The generic agent workflows (selector/implementer/reviewer/auditor) + role-invocation runtime live
// in autopilot/core/ and know nothing about RushPoint. We inject the project-specific glue here: the
// prompt/handoff directories, the working dir, config, the Claude runner, and the usage/log hooks. The
// returned `core` exposes runSelector / runImplementer / runReviewer / runAuditor (invoke + read the
// role's handoff) plus low-level invokeRole / readHandoff / clearHandoff.
// Stage 1 — API key pooling / load balancing. When config.api_pools holds keys with resolvable env
// tokens, the active adapter's run() is wrapped so each call pulls the next available key and a 429 /
// daily-budget hit rotates to the next account instead of stalling the loop. With no usable pool we
// keep the adapter's plain run() (single pinned-account path) — fully backward compatible.
const keyManager = createKeyManager(apiPools, { logger: log });
const baseRun = getAdapter(config).run;
const runClaudeSeam = keyRotationActive()
  ? makeRotatingRun({ adapter: getAdapter(config), keyManager, config: { ...config, keyRotation }, logger: log })
  : baseRun;

const core = createCore({
  promptDir: PROMPT_DIR,
  handoffDir: HANDOFF_DIR,
  // U-35: every role (selector/implementer/reviewer/auditor) runs in the config-driven git target —
  // the configured external repository or its managed worktree (GIT_ROOT), NOT a hardcoded path — so
  // the agents edit/inspect the same tree the supervisor's git.* operations act on. Defaults to
  // REPO_ROOT for the in-place RushPoint layout (GIT_ROOT === REPO_ROOT), so this is a no-op there.
  cwd: GIT_ROOT,
  config,
  // Provider-agnostic seam: the active adapter's run() (default Claude) is injected instead of a
  // hardcoded runClaude, so swapping providers = set config.provider + config.models (no core change).
  // The Claude adapter wraps runClaude 1:1; runClaudeSeam adds transparent key rotation when a pool is
  // configured (else it IS the adapter run — behavior-preserving).
  runClaude: runClaudeSeam,
  onUsage: recordUsage, // self-meter tokens/cost for the weekly-budget pacer
  resolveName: contextualName, // context-tag handoff basenames (U-34) so readHandoff matches handoffRel
  validateHandoff: validateOnLoad, // verify schema version + project scope on every handoff read (U-34)
  log
});

// Validate a handoff's schema envelope (version/timestamp/projectScope) as it is read back (U-34).
// Tolerant + non-blocking: a legacy/unstamped or outdated file is accepted (never corrupted); a clear
// migration message is logged once per file per process, and a projectScope that drifted in from another
// concurrent context is flagged. Dedup keeps the ephemeral agent handoffs from re-logging every cycle.
const _handoffMigLogged = new Set();
function validateOnLoad(file, data) {
  if (!data) return; // a missing handoff is handled by the caller's own null check
  const v = validateHandoffSchema(data, { context: contextId, file });
  if (v.migration && !_handoffMigLogged.has(file)) {
    _handoffMigLogged.add(file);
    log(`handoff schema: ${v.migration}`);
  }
  if (v.scopeMismatch) {
    log(`handoff schema: WARNING ${file} projectScope='${data.projectScope}' != active context '${contextId}' — possible cross-context collision in a shared handoff dir.`);
  }
}

// ---------- failure-learning memory core ----------
// Keywords that represent a task for similarity matching (title + acceptance + notes).
function taskKeywords(task) {
  return extractKeywords(`${task.title || ''} ${(task.acceptanceCriteria || []).join(' ')} ${task.notes || ''}`);
}
// Persist a lesson from a failed/struggling cycle via the post-mortem agent (core/post-mortem.mjs).
// The agent extracts explicit actionable rules and de-duplicates by rule similarity before persisting.
// failureType ∈ 'blocked' | 'rollback' | 'high-revision' | 'crash'. Idempotent per (taskId, failureType).
function recordLesson(task, { failureType, revisionCount = 0, impl, validation, review }) {
  runPostMortem(LESSONS_PATH, task, { failureType, revisionCount, impl, validation, review }, log);
}

// ---------- Architect Mode (Stage 2) ----------
// Decompose the earliest pending macro-vision task with the premium (Fable 5) tier. Returns true when a
// decomposition ran (so the caller ends the cycle and lets the new sub-tasks flow through selection).
async function maybeRunArchitect(state) {
  const acfg = config.architect || {};
  if (acfg.enabled === false || acfg.autoTrigger === false) return false;
  const min = Number.isInteger(acfg.minTasks) ? acfg.minTasks : ARCHITECT_MIN_TASKS;
  const max = Number.isInteger(acfg.maxTasks) ? acfg.maxTasks : ARCHITECT_MAX_TASKS;

  // Eligible = a USER-originated (or explicitly architect-flagged) backlog task that is a macro-vision
  // prompt and hasn't already been decomposed. We never auto-decompose the engine's own selector-
  // generated tasks — only what a human actually asked for. Prefer the earliest user task (strict FIFO).
  const isVision = (t) => t.status !== 'decomposed' && t.kind !== 'epic' &&
    (t.architect === true || (t.userRequested && isMacroVision(`${t.title}\n${t.notes || ''}`, t)));
  const alreadyDecomposed = (id) => state.queues.backlog.some((t) => t.parent_task_id === id) ||
    (Array.isArray(state.epics) && state.epics.some((e) => e.id === id));
  const vision = state.queues.backlog
    .filter((t) => isVision(t) && !alreadyDecomposed(t.id))
    .sort((a, b) => (a.userTaskSeq ?? Infinity) - (b.userTaskSeq ?? Infinity) || String(a.id).localeCompare(String(b.id)))[0];
  if (!vision) return false;

  const model = resolveModelForRole('architect', 'premium', config);
  log(`🏛️  ARCHITECT MODE — decomposing macro-vision "${vision.title}" with ${model} (target ${min}–${max} sub-tasks)…`);
  const vars = buildArchitectVars(vision, { min, max, handoffPath: handoffRel('architect.json') });
  const plan = await core.runArchitect(vars, model);
  if (!plan || !Array.isArray(plan.tasks) || !plan.tasks.length) {
    log('Architect produced no usable plan — leaving the vision task in the backlog for normal handling.');
    return false;
  }
  const { epic, subtasks, warnings } = normalizeArchitectPlan(plan, { epicId: vision.id, cycle: state.cycle, min, max, vision });
  for (const w of warnings) log(`   ⚠️ architect: ${w}`);
  if (!subtasks.length) { log('Architect plan normalized to zero sub-tasks — skipping.'); return false; }
  const res = applyArchitectPlanToState(state, vision.id, { epic, subtasks });
  state.stats.architectRuns = (state.stats.architectRuns || 0) + 1;
  await saveState(STATE_PATH, state);
  log(`🏛️  Architect injected ${res.injected} sub-task(s) under epic ${res.epicId} (${epic.title}).`);
  recordEvent('architect', { cycle: state.cycle, epicId: res.epicId, subtasks: res.injected, model });
  return res.injected > 0;
}

// Decide whether the SECOND-reviewer regression audit runs this cycle. It always runs for high-stakes
// classes (product/migration) and for anything at/above the risk floor; it is SKIPPED only for clearly
// low-risk engine/maintenance work that already cleared the adversarial reviewer + deterministic
// validation + the on-disk evidence gate. Fully config-driven (config.consensusAudit); the defaults
// below preserve safety (audit product/migration + risk ≥ 3) while saving one LLM call on the common
// low-risk engine/maintenance cycle. Set consensusAudit.enabled:false to force the audit to ALWAYS run.
function shouldRunAuditor(task, cls, config) {
  const c = config.consensusAudit || {};
  if (c.enabled === false) return true;                       // conditional-skip disabled → always audit
  const alwaysClasses = c.alwaysClasses || ['product', 'migration'];
  if (alwaysClasses.includes(cls)) return true;               // never skip high-stakes classes
  const minRiskToAudit = c.minRiskToAudit ?? 3;
  const risk = task.risk ?? 5;                                // unknown risk → treat as high (audit)
  if (risk >= minRiskToAudit) return true;
  if (task.userRequested) return true;                        // user tasks always get the full gate
  return false;                                               // low-risk engine/maintenance → skip the audit
}

// ---------- a single improvement cycle ----------
async function runCycle(state) {
  state.cycle += 1;
  state.stats.cyclesRun += 1;
  await core.clearHandoff();
  resetCycleUsage(); // start a fresh per-cycle usage tally (folded into state.usage on success)
  log(`===== Cycle ${state.cycle} =====`);

  // INBOX: pull in any tasks the user dropped since last cycle. They go to the FRONT of the backlog
  // and (via score.mjs userBoost) outrank everything, so a user request is always picked next.
  const userTasks = await ingestInbox(INBOX_DIR, state, state.cycle).catch((e) => {
    log(`⚠️  inbox read failed (non-fatal, continuing without new user tasks): ${e.message}`);
    return [];
  });
  if (userTasks.length) {
    for (const ut of userTasks) {
      const dup = [...state.queues.backlog, ...state.queues.done, ...state.queues.blocked].some((t) => t.id === ut.id);
      if (!dup) state.queues.backlog.unshift(ut);
    }
    state.stats.userTasksIngested = (state.stats.userTasksIngested || 0) + userTasks.length;
    log(`📥 Ingested ${userTasks.length} USER task(s) from inbox — they take priority:`);
    for (const ut of userTasks) log(`   • ${ut.id} [${ut.goal}] ${ut.title}`);
    await saveState(STATE_PATH, state);
  }

  // ARCHITECT MODE (Stage 2): a macro-vision prompt is NOT handed to the per-cycle implementer — it is
  // decomposed by the PREMIUM tier (Fable 5) into a dependency-ordered backlog of granular sub-tasks
  // which then flow through normal priority/dep-gated selection. Trigger on the earliest pending
  // macro-vision task that hasn't been decomposed yet. Best-effort: any failure falls through to
  // normal selection rather than crashing the cycle.
  const architected = await maybeRunArchitect(state).catch((e) => {
    log(`⚠️  architect decomposition failed (non-fatal, falling back to normal selection): ${e.message}`);
    return false;
  });
  if (architected) return { outcome: 'architected' };

  // Anti-churn: tasks that just failed are on a short cooldown — don't offer them as candidates this
  // cycle (so the loop progresses elsewhere), UNLESS every task is cooling down. User tasks never cool.
  const onCooldown = (t) => !t.userRequested && t.cooldownUntilCycle && state.cycle < t.cooldownUntilCycle;
  const selectable = state.queues.backlog.filter((t) => !onCooldown(t));
  // Stage 2 PRIORITY + DEPENDENCY gate: drop tasks whose deps aren't complete yet, then expose only the
  // FOREGROUND band (high+medium, plus user tasks) — background work (refactors/tests/docs) becomes
  // selectable ONLY when no foreground task is eligible (backlog empty or all waiting on a dependency).
  const doneIds = new Set(state.queues.done.map((t) => String(t.id)));
  const base = selectable.length ? selectable : state.queues.backlog;
  const gate = selectablePool(base, doneIds, effectiveTaskPriority);
  const pool = gate.pool.length ? gate.pool : base; // never strand the cycle if everything is waiting
  if (gate.band === 'background') log('No foreground (high/medium) task eligible — drawing from BACKGROUND band (refactor/test/docs).');
  if (gate.waiting.length) log(`${gate.waiting.length} task(s) waiting on unmet dependencies (deferred this cycle).`);

  // Rank the (selectable) backlog with the product-first scoring model and PRINT the top 5 candidates.
  const ranked = rankBacklog(pool, config);
  const share = productShare(state.queues.backlog);
  const productCount = state.queues.backlog.filter(isProduct).length;
  const weakBacklog = share < config.scoring.minProductShare || productCount < config.scoring.minProductTasks;
  log(`Top candidate tasks (product-first; ${Math.round(share * 100)}% product, ${productCount} product task(s)):`);
  for (const line of fmtRanked(ranked, 5).split('\n')) log('  ' + line);
  if (weakBacklog) log('Backlog is weak on product value — selector will generate stronger product tasks.');

  const weakNote = weakBacklog
    ? `\n## BACKLOG IS RUNNING LOW\n` +
      `The app is FEATURE-COMPLETE, so do NOT invent new features to fill the backlog. Instead add a ` +
      `few concrete **polish / hardening** tasks that each refine an EXISTING screen or flow — e.g. ` +
      `clearer loading/empty/error states, EN/HE translation gaps, accessibility, animation/feedback, ` +
      `edge-case robustness, offline/reconnect UX. For each one, FIRST Grep/Read to confirm the exact ` +
      `existing file you would improve, and name it in implementationHints. Never propose a feature ` +
      `that already exists (smart-station verify, builder, access codes, control-room all EXIST).\n`
    : '';

  // 1) SELECT --------------------------------------------------------------
  // P2 — Prompt fingerprint cache. The selector's decision is a pure function of the queue identity
  // (backlog/done/blocked ids+titles) + goal phase. When that fingerprint is unchanged the prior
  // decision is still correct, so we replay it instead of re-running the selector LLM. The fingerprint
  // changes the instant any queue membership/phase changes (i.e. the moment a task is picked, done, or
  // blocked), so a stale decision can never be replayed. Only the cheap SELECT step is cached — the
  // implementer (real code) always runs fresh against the live tree.
  // Key the cache on the SELECTABLE pool (post-cooldown filter), not the raw backlog, so a cache hit
  // can never replay a pick that's no longer eligible — e.g. a just-failed task now on an anti-churn
  // cooldown is absent from `pool`, which changes the fingerprint and forces a fresh selection.
  const selFp = selectorFingerprint(state, pool);
  // Estimated savings of a skipped selector call (the selector runs on the cheap tier). Used only to
  // CREDIT the cache stats on a hit; it never affects budget guards.
  const SELECTOR_EST_TOKENS = 8000;
  let selection = getCachedDecision(state, selFp, { tokens: SELECTOR_EST_TOKENS });
  if (selection) {
    log(`Selector decision served from fingerprint cache (hit-rate ${(cacheHitRate(state) * 100).toFixed(0)}%, ~${SELECTOR_EST_TOKENS} tok saved this hit).`);
  } else {
    // Build (or reuse) the local engine dep-graph and pass it as contextMaps — this activates the
    // U-45 dep-graph filter in runSelector so it prunes context to only engine-relevant files.
    // Falls back gracefully when the scan returns nothing (first call on a fresh install).
    const localMaps = config.disableDependencyOptimization === true ? null : buildLocalContextMaps();
    selection = await core.runSelector(
      {
        CANDIDATES: fmtRanked(ranked) || '(backlog empty)',
        WEAK_BACKLOG: weakNote,
        // Pass the FULL done/blocked history (titles only) so the selector never re-proposes an old
        // feature once the lists grow past a few dozen items over a long run.
        DONE: fmtTasks(state.queues.done, 300),
        BLOCKED: fmtTasks(state.queues.blocked, 300),
        NEXT_ID: nextTaskId(state),
        HANDOFF_PATH: handoffRel('selection.json')
      },
      undefined,
      {
        disableDependencyOptimization: config.disableDependencyOptimization === true,
        profileSelectorTokens: config.profileSelectorTokens === true,
        // Inject local engine dep-graph so the dep-graph filter runs even without an external contextProvider.
        contextMaps: localMaps || undefined,
      }
    );
    // Cache only a usable, task-selecting decision. A null/no-pick result is left uncached so the next
    // cycle re-asks (the backlog may have been topped up by the inbox in the meantime).
    if (selection?.selected) putCachedDecision(state, selFp, selection, { at: nowIso() });
  }
  if (!selection?.selected) {
    log('Selector produced no task. Skipping cycle.');
    return { outcome: 'no-task' };
  }

  // Merge any newly proposed backlog tasks (dedup by id/title; auto-drop obvious rebuilds).
  if (Array.isArray(selection.newBacklog)) {
    for (const nt of selection.newBacklog) {
      const all = [...state.queues.backlog, ...state.queues.done, ...state.queues.blocked];
      const exists = all.some((t) => t.id === nt.id || t.title === nt.title || titlesNearDuplicate(t.title, nt.title));
      if (!exists && nt.title && looksLikeRebuild(nt.title)) {
        log(`Dropped proposed rebuild task (already shipped): ${nt.title}`);
        continue;
      }
      if (exists && nt.title) { log(`Skipped near-duplicate proposed task: ${nt.title}`); continue; }
      if (!exists && nt.title) {
        state.queues.backlog.push({
          id: nt.id || nextTaskId(state), goal: nt.goal || 'gameplay', title: nt.title,
          dims: normDims(nt.dims), risk: nt.risk ?? 3, effort: nt.effort ?? 3, deps: nt.deps || [],
          source: 'selector', status: 'backlog', createdCycle: state.cycle, notes: nt.notes || ''
        });
      }
    }
  }

  // Resolve the chosen task object (reuse existing backlog item if id matches, else create).
  const sel = selection.selected;
  let task = state.queues.backlog.find((t) => t.id === sel.id || t.title === sel.title);
  if (!task) {
    task = { id: sel.id || nextTaskId(state), goal: sel.goal || 'gameplay', title: sel.title,
      dims: normDims(sel.dims), risk: sel.risk ?? 3, effort: sel.effort ?? 3, deps: [],
      source: 'selector', status: 'backlog', createdCycle: state.cycle, notes: '' };
  }

  // If the selector picked a rebuild of an already-shipped feature (and no user request is pending),
  // drop it and skip the cycle — the gates would reject it anyway; don't spend a cycle building it.
  const hasPendingUser = state.queues.backlog.some((t) => t.userRequested);
  if (!task.userRequested && !hasPendingUser && looksLikeRebuild(task.title)) {
    log(`Selector chose a rebuild of a shipped feature — dropping & skipping: ${task.title}`);
    state.queues.backlog = state.queues.backlog.filter((t) => t.id !== task.id && t !== task);
    await saveState(STATE_PATH, state);
    return { outcome: 'skipped-rebuild' };
  }

  // PRODUCTION HARDENING phase: UI/feature work is frozen. Drop any auto-generated UI-polish / new-feature
  // task (user inbox hardening tasks are exempt) — only resilience/concurrency/edge-case work is allowed.
  if (FILTERS.applyHardeningFreeze && config.phase === 'hardening' && !task.userRequested && looksLikeUiOrFeature(task)) {
    log(`HARDENING phase — dropping non-hardening (UI/feature) task: ${task.title}`);
    state.queues.backlog = state.queues.backlog.filter((t) => t.id !== task.id && t !== task);
    await saveState(STATE_PATH, state);
    return { outcome: 'skipped-ui-frozen' };
  }

  // HARD GUARANTEE: if the user has pending inbox tasks, one of them is ALWAYS worked on next —
  // even if the selector ignored it. Pick the earliest pending user task and (if the selector's
  // spec was for a different task) synthesize the spec from the user's own description.
  const pendingUser = state.queues.backlog
    .filter((t) => t.userRequested)
    .sort((a, b) => (a.userTaskSeq || 0) - (b.userTaskSeq || 0) || String(a.id).localeCompare(String(b.id)));
  // Force the EARLIEST pending user task whenever the selector picked either a non-user task OR a
  // later user task — user inbox tasks are built in strict FIFO order so dependent slices (e.g. a
  // client screen that reads a field a prior backend slice adds) are never built out of order.
  if (pendingUser.length && (!task.userRequested || task.id !== pendingUser[0].id)) {
    const forced = pendingUser[0];
    log(`⚑ Overriding selector — pending USER task ${forced.id} (earliest) takes priority over ${task.id}.`);
    if (sel.id !== forced.id && sel.title !== forced.title) {
      // selector didn't spec this one → carry the user's request straight through as the spec
      sel.acceptanceCriteria = forced.acceptanceCriteria || [];
      sel.implementationHints = forced.implementationHints || [];
      sel.rationale = `User-requested via inbox. ${forced.notes || ''}`.trim();
      sel.whyBeatAlternatives = 'Direct user request — always takes priority.';
      sel.visibleValue = forced.title;
      sel.dims = forced.dims;
      sel.goal = forced.goal;
      sel.risk = forced.risk;
      sel.effort = forced.effort;
      sel.downgradedFrom = null;
    }
    task = forced;
  }

  // enrich with this cycle's spec
  task.goal = sel.goal || task.goal;
  if (sel.dims) task.dims = normDims(sel.dims);
  task.risk = sel.risk ?? task.risk;
  task.effort = sel.effort ?? task.effort;
  task.acceptanceCriteria = sel.acceptanceCriteria || [];
  task.implementationHints = sel.implementationHints || [];
  task.rationale = sel.rationale || '';
  task.whyBeatAlternatives = sel.whyBeatAlternatives || '';
  task.visibleValue = sel.visibleValue || '';
  task.safeToContinue = sel.safeToContinue !== false;
  task.downgradedFrom = sel.downgradedFrom || null;
  task.status = 'in-progress';
  const taskScore = scoreTask(task, config);
  task.score = taskScore.total;
  log(`Selected ${task.id} (score ${taskScore.total}, ${isCleanup(task) ? 'cleanup' : 'product'}): ${task.title}`);

  // PRE-FLIGHT FAILURE MATCH: if this task closely resembles a past failure (Jaccard ≥ 0.6 over
  // keywords), escalate its engineering risk +1 (capped at 5 — feeds model routing below) and inject
  // the prior failure's avoid-hints into the implementer prompt so it sidesteps the known trap.
  let lessonsBlock = '';
  {
    const match = bestLessonMatch(taskKeywords(task), loadLessons(LESSONS_PATH, log), 0.6);
    if (match) {
      const before = Number(task.risk) || 3;
      task.risk = Math.min(5, before + 1);
      const l = match.lesson;
      log(`⚠️ Pre-flight: ${task.id} resembles past failure ${l.id} (${l.failureType}, Jaccard ${match.sim.toFixed(2)}) — risk ${before}→${task.risk}.`);
      lessonsBlock = `## ⚠️ A SIMILAR TASK FAILED BEFORE (${l.failureType}) — do not repeat it\n` +
        `Prior failed task: ${l.title}\n` +
        (l.errorSummary ? `What went wrong: ${l.errorSummary}\n` : '') +
        ((l.avoidHints || []).length ? `Avoid / required fixes:\n - ${l.avoidHints.join('\n - ')}\n` : '') +
        ((l.filesInvolved || []).length ? `Files previously involved: ${l.filesInvolved.join(', ')}\n` : '') +
        `Proceed carefully and address the above up front.\n\n`;
    }
  }

  // remove from backlog, set as current (so recovery can re-queue it)
  state.queues.backlog = state.queues.backlog.filter((t) => t !== task && t.id !== task.id);
  // STRUCTURAL-IMPOSSIBILITY GUARD: if a task's acceptance criteria require editing a file that the
  // protect.mjs freeze currently forbids, no implementer can satisfy it THIS run — block it deterministically
  // instead of burning cycles retrying. (No-op once core/.ready lifts the freeze → frozen list is empty.)
  const frozen = frozenProtectedFiles();
  if (frozen.length) {
    const hay = [task.title, ...(task.acceptanceCriteria || []), ...(task.implementationHints || [])].join(' ').toLowerCase();
    const hits = frozen.filter((f) => hay.includes(f.toLowerCase()));
    if (hits.length) {
      task.status = 'blocked';
      task.blockReason = `structurally impossible this run: acceptance criteria require editing frozen file(s) [${hits.join(', ')}] while the engine freeze is active (autopilot/core/.ready absent). Lift the freeze or revise the criteria.`;
      task.structuralBlock = true;
      state.queues.backlog = state.queues.backlog.filter((t) => t.id !== task.id && t !== task);
      state.queues.blocked.push(task);
      state.stats.blocked = (state.stats.blocked || 0) + 1;
      await saveState(STATE_PATH, state);
      log(`⛔ Structural block (not retried): ${task.id} — ${task.blockReason}`);
      return { outcome: 'blocked-structural' };
    }
  }

  state.current = task;
  await saveState(STATE_PATH, state);

  // Decide the implementer model for THIS task: class + risk + REMAINING BUDGET. The governor's
  // downgrade signal (persisted on state.budget by the loop) forces a cheaper tier deterministically —
  // the LLM never chooses its own budget path.
  const route = pickImplementerModel(task, config, { budgetAction: state.budget?.action });
  task.implementerModel = route.model;
  task.implementerTier = route.tier;
  task.implementerReason = route.reason;
  log(`Implementer model → ${(route.tierLabel || route.tier).toUpperCase()} (${route.model}) — ${route.reason}`);

  // 2) SNAPSHOT + IMPLEMENT/REVIEW loop -----------------------------------
  // Work happens directly on the integration branch; we snapshot HEAD and, on any non-approval,
  // reset --hard back to it. No cycle branches (those raced with the implementer's own git in a
  // shared worktree and let unreviewed commits leak onto main).
  await git.ensureOnIntegration(GIT_ROOT, config.git.integrationBranch);
  const baseSha = await git.revParse(GIT_ROOT, 'HEAD');
  task.baseSha = baseSha;
  await saveState(STATE_PATH, state);

  // Lint-regression baseline: count existing ESLint errors on the CLEAN branch now, so the guard can
  // fail the cycle if the implementer INTRODUCES new ones (without punishing pre-existing debt).
  let lintBaseline = null;
  if (wsConfig.validation.lintRegressionGuard) {
    try { lintBaseline = await countLintErrors(wsConfig, GIT_ROOT); log(`Lint baseline: ${lintBaseline} pre-existing error(s).`); } catch { /* non-fatal */ }
  }

  // Class-aware review: classify the task and pick the gate its class implies. Engine/maintenance/
  // migration work lives in the gitignored /autopilot/ tree (no git diff) and is judged by on-disk
  // EVIDENCE, not the product-delivery gate — this is the fix for the policy-contradiction deadlock.
  const taskClass = classifyTask(task, config);
  const policy = reviewPolicy(taskClass, config);
  task.class = taskClass;
  log(`Task class → ${taskClass} (gate: ${policy.productGate ? 'product-delivery' : 'on-disk-evidence'})`);

  const taskJson = JSON.stringify({
    id: task.id, title: task.title, goal: task.goal, class: taskClass,
    acceptanceCriteria: task.acceptanceCriteria, implementationHints: task.implementationHints,
    rationale: task.rationale, downgradedFrom: task.downgradedFrom
  }, null, 2);

  // P1 — Context compiler. A deterministic keyword scan over `git ls-files` names the files most likely
  // relevant to this task, injected as an ADVISORY CONTEXT_HINT so the implementer starts at the right
  // place instead of blind-exploring. It never restricts what the LLM may open (it still uses its own
  // tools), so it can only save exploration tokens, never hide a needed file. Best-effort: a failure
  // (no git, empty scan) yields an empty hint and the prompt is unchanged.
  let contextHint = '';
  try {
    const compiled = compileContext({ task, repoRoot: GIT_ROOT, maxFiles: 8 });
    contextHint = contextHintBlock(compiled);
    if (compiled.files.length) {
      log(`Context compiler: ${compiled.files.length}/${compiled.metrics.scanned} files relevant ` +
        `(~${compiled.metrics.reductionPct}% smaller than the candidate pool) — ${compiled.files.slice(0, 4).map((f) => f.path).join(', ')}…`);
    }
  } catch (e) { log('context compiler skipped:', e.message); }

  let verdict = 'reject';
  let review = null;
  let impl = null;
  let attempt = 0;
  let validation = { ok: false, summary: 'not run' };
  let autoFixResult = { fixed: false, summary: 'not run' };
  // CROSS-CYCLE MEMORY: if this task already failed review/validation in an EARLIER cycle, seed the
  // implementer's first attempt with WHY it failed last time — so it fixes the known issue up front
  // instead of re-deriving (and likely repeating) the same mistake. (Within-cycle revises are handled
  // separately below.)
  let revisionBlock = lessonsBlock;
  if (task.lastFailure) {
    const f = task.lastFailure;
    revisionBlock += `## ⚠️ THIS TASK FAILED IN A PREVIOUS CYCLE — fix the known problem first\n` +
      `Last time (cycle ${f.cycle}) it was ${f.verdict || 'rejected'} for:\n - ${(f.reasons || []).join('\n - ') || f.summary || 'see fixes'}\n` +
      ((f.requiredFixes || []).length ? `Required fixes:\n - ${f.requiredFixes.join('\n - ')}\n` : '') +
      (f.validation && !/PASS .*FAIL/.test(f.validation) ? `Validation then: ${f.validation}\n` : '') +
      `Address THIS specifically before anything else.\n\n`;
    log(`↺ Seeding implementer with prior-cycle failure memory (cycle ${f.cycle}).`);
  }

  // Tracks whether the PREVIOUS iteration's failure was mechanical (failing validation) vs a reviewer
  // judgement — drives the Haiku-first revision triage on the next attempt.
  let lastFailureMechanical = false;
  while (attempt <= config.cycle.maxReviseAttempts) {
    // Per-attempt model: the first attempt (and any logic/scope revise) uses the risk/category route.
    // A FIRST mechanical retry (validation broke: typecheck/lint/build) is triaged to Haiku — cheap+fast
    // for the trivial type/import/syntax patch it almost always is; we escalate back to `route` if it fails.
    let attemptModel = route.model;
    if (attempt >= 1) {
      const triage = pickRevisionModel(task, config, { attempt, mechanical: lastFailureMechanical, budgetAction: state.budget?.action });
      if (triage) { attemptModel = triage.model; log(`↳ ${triage.reason}`); }
    }
    // IMPLEMENT (model chosen by risk/category routing above, or Haiku-triaged for a mechanical retry)
    impl = await core.runImplementer({
      TASK_JSON: taskJson,
      TASK_CLASS: taskClass,
      CYCLE_BRANCH: config.git.integrationBranch,
      REVISION_BLOCK: revisionBlock,
      CONTEXT_HINT: contextHint,
      PROFILE_RULES: WORKSPACE.profile.promptProfile || '',
      HANDOFF_PATH: handoffRel('implementation.json')
    }, attemptModel);

    // Make sure we're back on the integration branch (the implementer may have switched branches)
    // and capture any uncommitted work it left behind. All commits accumulate on integration and
    // are rolled back to baseSha if the cycle isn't approved.
    await git.checkoutIntegrationKeepingWork(GIT_ROOT, config.git.integrationBranch);
    const autoCommitted = await git.commitAllIfDirty(GIT_ROOT, `${config.git.commitPrefix}: ${task.id} ${task.title}`);
    if (autoCommitted) log('Captured implementer changes on integration branch.');

    // AUTO-FIX (U-46) — run eslint --fix + import-sort before validation to eliminate trivial issues
    autoFixResult = await runAutoFixes(wsConfig, GIT_ROOT, git, log);
    if (autoFixResult.fixed) {
      log(`Auto-fixes applied: ${autoFixResult.summary}${autoFixResult.committed ? ' (committed)' : ''}`);
    } else if (autoFixResult.summary !== 'auto-fix disabled') {
      // Log even when no fixes committed, if auto-fix ran (files may be unchanged or errors remain)
      const errorDelta = autoFixResult.errorsFixed !== null && autoFixResult.errorsFixed >= 0
        ? ` [auto-fixed: ${autoFixResult.errorsFixed} error(s)]`
        : autoFixResult.errorsBefore !== null && autoFixResult.errorsAfter !== null
        ? ` [errors unchanged: ${autoFixResult.errorsBefore}]`
        : '';
      log(`Auto-fix attempted: ${autoFixResult.summary}${errorDelta}`);
    }

    // VALIDATE (deterministic) — includes typecheck + admin build (required) + lint-regression guard
    log('Running validation…');
    validation = await runValidation(wsConfig, GIT_ROOT, lintBaseline, { cacheFile: VALIDATION_CACHE_PATH });
    log(`Validation: ${validation.summary}`);
    // U-46: Explicit reporting of auto-fixed vs AI-resolved errors
    if (autoFixResult && autoFixResult.errorsFixed !== null) {
      const aiRequired = autoFixResult.errorsAfter || 0;
      log(`  Auto-fixed: ${autoFixResult.errorsFixed} error(s) | Remaining for AI: ${aiRequired}`);
    }

    // On-disk EVIDENCE for the reviewer's gate: prefer the implementer's declared verifyArtifacts,
    // else fall back to whatever the task itself declares. Catches "dead file nobody imports" + "named
    // module missing" — so a green typecheck on unwired code can't be certified done.
    const evidenceArtifacts = (impl && Array.isArray(impl.verifyArtifacts) && impl.verifyArtifacts.length)
      ? { verifyArtifacts: impl.verifyArtifacts } : task;
    const evidence = checkEvidence(evidenceArtifacts, REPO_ROOT);
    log(`On-disk evidence: ${evidence.summary}`);

    // REVIEW (independent agent)
    review = await core.runReviewer({
      TASK_JSON: taskJson,
      TASK_CLASS: taskClass,
      REVIEW_POLICY: JSON.stringify(policy),
      EVIDENCE: evidence.summary,
      IMPL_REPORT: JSON.stringify(impl || { summary: 'no handoff written' }, null, 2),
      VALIDATION: validation.summary + '\n' + validation.results.map((r) => `${r.name}: ${r.ok ? 'ok' : r.tail}`).join('\n'),
      INTEGRATION_BRANCH: config.git.integrationBranch,
      HANDOFF_PATH: handoffRel('review.json')
    });
    verdict = review?.verdict || 'reject';
    log(`Review verdict: ${verdict}`);

    if (verdict === 'approve' && validation.ok) {
      // CONSENSUS GATE: a SECOND, independent reviewer audits specifically for regressions, scope
      // creep, and broken existing behavior. We merge ONLY if both the reviewer AND the auditor
      // approve — the single biggest lever for trustworthy autonomous merges.
      //
      // CONDITIONAL AUDIT (cost+latency saver): the second audit adds the MOST value on high-stakes
      // work (product/migration/risky). For low-risk engine/maintenance tasks that ALREADY passed the
      // adversarial reviewer + deterministic validation + the on-disk evidence gate, the marginal
      // regression risk is small — so skip the extra LLM call there. Tunable via config.consensusAudit;
      // defaults keep the full audit for product/migration and anything at/above minRiskToAudit.
      if (shouldRunAuditor(task, taskClass, config)) {
        const audit = await core.runAuditor({
          TASK_JSON: taskJson,
          TASK_CLASS: taskClass,
          EVIDENCE: evidence.summary,
          IMPL_REPORT: JSON.stringify(impl || { summary: 'no handoff' }, null, 2),
          VALIDATION: validation.summary,
          INTEGRATION_BRANCH: config.git.integrationBranch,
          HANDOFF_PATH: handoffRel('audit.json')
        });
        const auditVerdict = audit?.verdict;
        log(`Regression audit verdict: ${auditVerdict || '(none)'}`);
        // VETO-ON-OBJECTION: the reviewer already approved + validation is green, so we ship UNLESS the
        // auditor raises an EXPLICIT objection. A missing/garbled auditor handoff (a tooling hiccup, not a
        // quality signal) must NOT halt all productivity — it falls through to merge on the first review.
        if (auditVerdict !== 'reject' && auditVerdict !== 'revise') break;   // approve / unclear / missing → ship
        // Auditor objected → fold its findings into the bounded revision loop.
        review = { verdict: auditVerdict, reasons: audit?.reasons, requiredFixes: audit?.requiredFixes, riskNotes: audit?.riskNotes };
        verdict = auditVerdict;
        if (verdict === 'reject') break;
      } else {
        log(`Regression audit SKIPPED (low-risk ${taskClass}, risk ${task.risk ?? '?'}/5 — reviewer + validation + evidence gate sufficient).`);
        break;   // reviewer approved + validation green + evidence ok → ship
      }
    } else if (verdict === 'reject') {
      break;
    }
    // verdict === 'revise' (or audit-driven revise, or approve-but-validation-failed) → bounded retry.
    // MECHANICAL = validation is failing (typecheck/lint/build broke): the next retry is Haiku-triaged.
    // A reviewer 'revise' with GREEN validation is a logic/scope issue → keep the strong model.
    lastFailureMechanical = !validation.ok;
    attempt += 1;
    state.stats.revisions += 1;
    if (attempt > config.cycle.maxReviseAttempts) break;
    const fixes = (review?.requiredFixes || []).join('\n - ') || 'Address the reviewer reasons and fix failing validation.';
    const autoFixNote = autoFixResult.fixed ? `\n(NOTE: Auto-fixes already tried: ${autoFixResult.summary}. The remaining issues require manual code changes.)\n` : '';
    revisionBlock = `## Reviewer requested changes (revision ${attempt})\nFix these precisely, then re-commit:\n - ${fixes}\n` +
      autoFixNote +
      (validation.ok ? '' : `\nValidation is currently FAILING: ${validation.summary}. Make it pass.\n`);
    log(`Revision ${attempt} requested.`);
  }

  // 3) FINALIZE -----------------------------------------------------------
  const approved = verdict === 'approve' && validation.ok;
  // Did the cycle actually produce committed work? (HEAD moved past the snapshot.)
  const headSha = await git.revParse(GIT_ROOT, 'HEAD');
  const hasWork = headSha !== baseSha;
  const diffStat = hasWork ? (await git.diffAgainst(GIT_ROOT, baseSha)).trim() : '';
  const appImpact = impl?.appImpact || impl?.summary || '(no impact statement)';
  // CLASS-AWARE DELIVERY: product work is "delivered" only if it committed a diff (hasWork). Engine/
  // maintenance/migration work lives in gitignored /autopilot/ and NEVER commits — for it, delivery is
  // proven by on-disk EVIDENCE (named modules present + wired). Without this, an approved engine task
  // would fall into the "approved but nothing shipped" branch forever (the second structural deadlock).
  const finalEvidence = checkEvidence(
    (impl && Array.isArray(impl.verifyArtifacts) && impl.verifyArtifacts.length) ? { verifyArtifacts: impl.verifyArtifacts } : task,
    REPO_ROOT
  );
  const delivered = policy.gitDiffRequired ? hasWork : (hasWork || finalEvidence.ok);
  let outcome;
  if (approved && delivered) {
    // Work is already committed on the integration branch — keep it.
    outcome = 'merged';
    // PROOF OF PROGRESS — mandatory product-delivery report.
    log('───── USER IMPACT SUMMARY ─────');
    log('  ' + (impl?.userImpactSummary || appImpact));
    log('───── WHAT IS NOW LIVE IN THE PRODUCT ─────');
    log('  ' + (impl?.nowLive || appImpact));
    log('───── WHAT A PLAYER SEES DIFFERENTLY ─────');
    log('  ' + (impl?.playerVisibleChange || '(implementer did not specify)'));
    log('───── FILE-LEVEL DIFF ─────');
    if (diffStat) for (const l of diffStat.split('\n')) log('  ' + l);
    else log('  (no git diff — gitignored engine work; delivery proven by evidence below)');
    if (!policy.gitDiffRequired) log('───── ON-DISK EVIDENCE ─────\n  ' + finalEvidence.summary);
    task.status = 'done';
    task.doneCycle = state.cycle;
    // Persist STRUCTURED evidence so future reconciliation can verify this task against disk (the
    // reliable signal — not free-text). Prefer the implementer's declared artifacts.
    if (impl && Array.isArray(impl.verifyArtifacts) && impl.verifyArtifacts.length) {
      task.verifyArtifacts = impl.verifyArtifacts;
    }
    state.queues.done.push(task);
    state.stats.completed += 1;

    // PARTIAL-COMPLETION RE-QUEUE: if a user-requested task shipped only a SLICE (the implementer's
    // notes contain "deferred", "remaining", "follow-up", "NOT satisfied", "undone"), automatically
    // create a continuation task so the rest doesn't silently disappear.
    if (task.userRequested && task.source !== 'auto-continuation') {
      // Only ONE auto-continuation per original user task — never chain (no -cont-cont runaway). If the
      // continuation is itself partial, it surfaces in the decision log for the user to re-queue manually.
      const notesLower = (impl?.notes || '').toLowerCase();
      const isPartial = /defer|remain|follow.?up|not satisfied|undone|not attempted|subsequent cycle|not completed/i.test(notesLower);
      if (isPartial) {
        const contId = `${task.id}-cont`;
        const alreadyQueued = [...state.queues.backlog, ...state.queues.done, ...state.queues.blocked].some(t => t.id === contId);
        if (!alreadyQueued) {
          const cont = {
            ...task, id: contId, status: 'backlog', doneCycle: undefined,
            title: `${task.title} (continuation — remaining work from cycle ${state.cycle})`,
            notes: `Continuation of ${task.id} which was only partially completed. The implementer noted: ${impl.notes.slice(0, 400)}`,
            source: 'auto-continuation', createdCycle: state.cycle
          };
          delete cont.baseSha; delete cont.cooldownUntilCycle;
          state.queues.backlog.push(cont);
          log(`📋 Partial user task — queued continuation: ${contId}`);
        }
      }
    }
  } else if (approved && !delivered) {
    // Approved but delivery NOT proven: for product = no commit; for engine/maint/migration = the named
    // modules are missing/unwired on disk. Either way the work didn't actually ship. Never mark "done".
    const why = policy.gitDiffRequired ? 'no visible product change committed' : `on-disk evidence incomplete (${finalEvidence.summary})`;
    task.noChangeAttempts = (task.noChangeAttempts || 0) + 1;
    if (task.noChangeAttempts >= config.scoring.maxAttemptsBeforeBlock) {
      task.status = 'blocked';
      task.blockReason = `approved but undelivered (${why}) in ${task.noChangeAttempts} cycles — needs manual breakdown`;
      state.queues.blocked.push(task);
      state.stats.blocked += 1;
      outcome = 'blocked-no-change';
    } else {
      task.status = 'backlog';
      task.forceDowngrade = true;
      task.notes = (task.notes || '') + ` [retry ${task.noChangeAttempts}: approved but undelivered — ${why}. Deliver the named modules (present AND wired) this cycle]`;
      // Anti-churn: cool this task down for 2 cycles and send it to the BACK so the loop makes
      // progress on OTHER tasks instead of hammering the same stuck one cycle after cycle.
      task.cooldownUntilCycle = state.cycle + 5;
      state.queues.backlog.push(task);
      outcome = 're-queued-smaller';
    }
  } else {
    // Not approved → roll the integration branch back to the pre-cycle snapshot (discard all commits).
    await git.resetHard(GIT_ROOT, baseSha);
    // CROSS-CYCLE MEMORY: remember exactly WHY it failed, so a future attempt fixes the known issue
    // up front (injected into the implementer prompt next time) instead of repeating the mistake.
    task.lastFailure = {
      cycle: state.cycle, verdict,
      reasons: review?.reasons || [],
      requiredFixes: review?.requiredFixes || [],
      validation: validation.summary
    };
    if (verdict === 'reject') {
      // Hard reject = wrong/unsafe approach → blocking is correct; a retry won't help.
      task.status = 'blocked';
      task.blockReason = review?.reasons?.join('; ') || 'rejected by reviewer';
      state.queues.blocked.push(task);
      state.stats.blocked += 1;
      outcome = 'blocked';
    } else {
      // Revise-exhausted (FIXABLE issues) → grant ONE more cross-cycle attempt WITH the failure memory
      // (bounded), then block. The seeded memory makes that next attempt target the known problem.
      task.reviewFailAttempts = (task.reviewFailAttempts || 0) + 1;
      if (task.reviewFailAttempts >= (config.scoring.maxReviewFailAttempts ?? 2)) {
        task.status = 'blocked';
        task.blockReason = `did not pass review/validation after ${task.reviewFailAttempts} cross-cycle attempts; ${validation.summary}`;
        state.queues.blocked.push(task);
        state.stats.blocked += 1;
        outcome = 'blocked';
      } else {
        task.status = 'backlog';
        task.cooldownUntilCycle = state.cycle + 3;
        state.queues.backlog.push(task);
        outcome = 're-queued-with-memory';
      }
    }
  }

  // FAILURE LEARNING: capture a lesson when the task got blocked, was rolled back (not approved), or
  // churned through ≥2 revisions — so a future similar task is flagged + de-risked at pre-flight.
  {
    const revisionCount = attempt;
    let failureType = null;
    if (task.status === 'blocked') failureType = 'blocked';
    else if (!approved) failureType = 'rollback';
    else if (revisionCount >= 2) failureType = 'high-revision';
    if (failureType) recordLesson(task, { failureType, revisionCount, impl, validation, review });
  }

  // advance goal phase if recommended and backlog of this phase is thin
  if (selection.recommendedPhase && selection.recommendedPhase !== state.goalPhase &&
      (WORKSPACE.profile.goalPhases || GOAL_PHASES).includes(selection.recommendedPhase)) {
    state.goalPhase = selection.recommendedPhase;
    log(`Advancing goal phase → ${state.goalPhase}`);
  }

  // P3 — Cost learning. Record this cycle's REAL token cost + revise count into the rolling per-bucket
  // window (key = class:risk) so the governor's per-cycle estimate sharpens over time. Advisory only:
  // it refines the central estimate but never overrides the governor's hard reserve/stop guards. Read
  // _cycleUsage here (still live) — foldCycleUsage clears it later, in the main loop.
  try {
    recordCycleCost(state, task, { tokens: currentCycleTokens(), retries: attempt }, config);
    const learned = improvedEstimate(state, task, config);
    if (learned != null) log(`Cost learning: ${costKey(task, config)} avg ≈ ${Math.round(learned / 1000)}k tok/cycle (informs the budget estimate).`);
  } catch (e) { log('cost learning skipped:', e.message); }

  // record + persist
  state.current = null;
  state.history.push({ cycle: state.cycle, taskId: task.id, title: task.title, outcome, ts: nowIso() });
  await appendDecision(STATE_DIR, {
    cycle: state.cycle, ts: nowIso(), taskId: task.id, title: task.title, goalPhase: task.goal,
    rationale: task.rationale, downgradedFrom: task.downgradedFrom, validation: validation.summary,
    whyBeatAlternatives: task.whyBeatAlternatives, visibleValue: task.visibleValue,
    safeToContinue: task.safeToContinue,
    verdict, reviseAttempts: attempt, outcome,
    implementerModel: `${task.implementerTier} (${task.implementerModel}) — ${task.implementerReason}`,
    score: `${task.score} (${isCleanup(task) ? 'cleanup' : 'product'})`,
    proof: outcome === 'merged' ? {
      userImpact: impl?.userImpactSummary || appImpact,
      nowLive: impl?.nowLive || appImpact,
      playerSees: impl?.playerVisibleChange || '(unspecified)'
    } : null,
    evidence: outcome === 'merged' ? `${appImpact}\n\n    ${diffStat.replace(/\n/g, '\n    ')}` : null,
    notes: [impl?.notes, review?.riskNotes].filter(Boolean).join(' | ')
  });
  await writeMirrors(STATE_DIR, state);
  await saveState(STATE_PATH, state);
  log(`Cycle ${state.cycle} → ${outcome}`);
  return { outcome };
}

// ---------- circuit breaker ----------
// Trip the breaker and HALT the whole loop. We write the STOP flag so the watchdog (which honors it on
// every iteration) stays down instead of hot-restarting into the same failure — a true halt that
// survives process death. Any in-flight work is rolled back and re-queued first. Resume after the
// operator fixes the cause with:  node autopilot/supervisor.mjs reset-breaker  (then `start`).
async function haltViaCircuitBreaker(state, reason) {
  tripBreaker(state, reason, nowIso());
  state.status = 'halted-circuit-breaker';
  if (state.current) {
    if (state.current.baseSha) await git.resetHard(GIT_ROOT, state.current.baseSha).catch(() => {});
    await git.ensureOnIntegration(GIT_ROOT, config.git.integrationBranch).catch(() => {});
    state.current.status = 'backlog';
    state.queues.backlog.unshift(state.current);
    state.current = null;
  }
  recordEvent('error', { kind: 'circuit-breaker', cycle: state.cycle, message: reason });
  await flushTelemetry().catch(() => {});
  syncTelemetry(state);
  await saveState(STATE_PATH, state);
  await writeFile(STOP_FLAG, `circuit-breaker: ${reason} @ ${nowIso()}`, 'utf8').catch(() => {});
  log(`🛑 CIRCUIT BREAKER TRIPPED — ${reason}. Loop halted; STOP flag set. Fix the cause, then: node autopilot/supervisor.mjs reset-breaker && node autopilot/supervisor.mjs start`);
}

// ---------- budget governor halt ----------
// Deterministic quota guard: STOP EARLY rather than risk exceeding the weekly quota. Writes the STOP
// flag (watchdog stays down) so the loop halts cleanly; the operator resumes with `start` after the
// weekly window resets (state.usage.windowResetAt) and the counters clear. Conservative by design.
async function haltForBudget(state, gov) {
  state.status = 'halted-budget';
  state.budget = { ...(state.budget || {}), halted: true, haltedAt: nowIso(), reason: gov.reason };
  recordEvent('error', { kind: 'budget-stop', cycle: state.cycle, message: gov.reason });
  await flushTelemetry().catch(() => {});
  syncTelemetry(state);
  await saveState(STATE_PATH, state);
  await writeFile(STOP_FLAG, `budget-governor: ${gov.reason} @ ${nowIso()}`, 'utf8').catch(() => {});
  log(`🛑 BUDGET GOVERNOR — STOP. ${gov.reason}. Spent ${Math.round(gov.spent / 1000)}k/${Math.round(gov.quota / 1000)}k tok this window. Halted to protect quota; resume after the window resets with: node autopilot/supervisor.mjs start`);
}

// ---------- rate-limit pause ----------
async function pauseForRateLimit(state, err) {
  state.rateLimit.consecutiveHits += 1;
  state.stats.rateLimitPauses += 1;
  increaseAdaptiveInterval(state);
  const backoff = Math.min(
    config.rateLimit.baseCooldownMs * state.rateLimit.consecutiveHits,
    config.rateLimit.maxCooldownMs
  );
  // Use a parsed real reset time if we got one, else the (gentle) backoff — but ALWAYS cap at
  // maxCooldownMs so a single bad moment can't lock the loop out for hours. Retrying every ≤45 min is
  // cheap (a rate-limited call does no work) and catches a rolling-window quota refresh far sooner.
  const wait = Math.min(
    err.retryAfterMs && err.retryAfterMs > 0 ? err.retryAfterMs : backoff,
    config.rateLimit.maxCooldownMs
  );
  state.rateLimit.pausedUntil = new Date(Date.now() + wait).toISOString();
  state.status = 'paused-ratelimit';

  // Roll the integration branch back to this cycle's snapshot (discard partial work) and re-queue.
  if (state.current) {
    if (state.current.baseSha) await git.resetHard(GIT_ROOT, state.current.baseSha).catch(() => {});
    state.current.status = 'backlog';
    state.queues.backlog.unshift(state.current);
    state.current = null;
  }
  await saveState(STATE_PATH, state);
  log(`RATE LIMIT — pausing ${Math.round(wait / 60000)} min (until ${state.rateLimit.pausedUntil}).`);
  await sleep(wait);
  state.status = 'running';
  await saveState(STATE_PATH, state);
}

// ---------- weekly budget pacer ----------
// The Claude account is SHARED with the user's own sessions, so rather than guess an absolute token
// cap we pace by cadence: enforce a minimum gap between cycle starts (= 24h / maxCyclesPerDay) so the
// kinetic's consumption is spread evenly to the weekly reset and leaves headroom for the user.
// Self-metered usage (state.usage) is for visibility + tuning. Called once per loop iteration.
async function paceForWeeklyBudget(state) {
  const wb = config.weeklyBudget;
  if (!wb || !wb.enabled) return;
  const u = ensureUsage(state);

  // Initialize / roll the weekly window.
  if (!u.windowResetAt) { u.windowResetAt = wb.resetAt; u.windowStartedAt = nowIso(); }
  while (new Date(u.windowResetAt).getTime() <= Date.now()) {
    const next = new Date(new Date(u.windowResetAt).getTime() + (wb.resetIntervalDays || 7) * 86400000).toISOString();
    log(`Weekly window reset (${u.windowResetAt} → ${next}); usage counters cleared.`);
    Object.assign(u, {
      windowResetAt: next, windowStartedAt: nowIso(),
      cycles: 0, calls: 0, inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheCreationTokens: 0, costUsd: 0
    });
  }

  // Adaptive cadence: a velocity factor = (fraction of the cycle budget used) / (fraction of the
  // weekly window elapsed). >1 ⇒ we're burning faster than the clock, so throttle the configured rate
  // (÷ velocityFactor, floored at 4/day); ≤1 ⇒ run at the full configured rate.
  const velocityFactor = computeVelocityFactor({
    cycles: u.cycles, windowStartedMs: u.windowStartedAt ? new Date(u.windowStartedAt).getTime() : Date.now(),
    resetIntervalDays: wb.resetIntervalDays, maxCyclesPerDay: wb.maxCyclesPerDay,
    velocitySensitivity: wb.velocitySensitivity
  });
  u.velocityFactor = velocityFactor;

  // Cadence throttle: keep at most (velocity-adjusted) maxCyclesPerDay by spacing cycle starts evenly.
  let perDay = effectivePerDay(wb.maxCyclesPerDay, velocityFactor);
  if (velocityFactor > 1.0) log(`Velocity ${velocityFactor.toFixed(2)}x over budget — throttling cadence ${Math.max(1, Number(wb.maxCyclesPerDay) || 24)}→${perDay} cycles/day.`);
  // Per-project token budget (U-33): when THIS project (PROJECT_ID) has exhausted its configured token
  // cap, drop to the minimum cadence so it can't keep burning the shared account — independently of any
  // other project's budget. No-op when no budget is configured (isWithinBudget stays true).
  if (!isWithinBudget(PROJECT_ID, config, state)) {
    const cap = budgetTokenCap(projectBudget(PROJECT_ID, config));
    const spent = (state.tokenSpent && state.tokenSpent[PROJECT_ID]) || 0;
    perDay = Math.min(perDay, 4);
    log(`Project "${PROJECT_ID}" over token budget (${Math.round(spent / 1000)}k/${Math.round(cap / 1000)}k tok) — capping cadence at ${perDay} cycles/day.`);
  }
  // AIMD adaptive interval: self-tunes per observed rate-limit pressure.
  // Falls back to the legacy maxCyclesPerDay floor so the config cap is still honoured.
  const legacySpacingMs = Math.round(86400000 / perDay);
  const minSpacingMs = Math.max(legacySpacingMs, u.adaptiveIntervalMs || ADAPTIVE_INITIAL_MS);
  if (u.lastCycleAt) {
    const tillReset = new Date(u.windowResetAt).getTime() - Date.now();
    let waitMs = Math.min(minSpacingMs - (Date.now() - new Date(u.lastCycleAt).getTime()), Math.max(0, tillReset));
    if (waitMs > 0) {
      log(`AIMD pacing: waiting ${Math.round(waitMs / 60000)} min (adaptive=${Math.round((u.adaptiveIntervalMs || ADAPTIVE_INITIAL_MS) / 60000)}min; ≤${perDay} cycles/day; ${u.cycles} done, ~$${u.costUsd.toFixed(2)} this window).`);
      for (let slept = 0; slept < waitMs; slept += 30000) {
        if (existsSync(STOP_FLAG)) { log('STOP flag during pacing — exiting wait.'); return; }
        await sleep(Math.min(30000, waitMs - slept));
      }
    }
  }
  u.lastCycleAt = nowIso();
  u.cycles += 1;
  await saveState(STATE_PATH, state);
}

// ---------- recovery on startup ----------
async function recover(state) {
  await git.ensureIntegrationBranch(GIT_ROOT, config.git.integrationBranch, config.git.baseBranch);
  if (state.current) {
    log(`Recovering interrupted cycle: rolling back + re-queuing ${state.current.id}`);
    // Discard any partial commits from the interrupted cycle by resetting to its snapshot.
    if (state.current.baseSha) await git.resetHard(GIT_ROOT, state.current.baseSha).catch(() => {});
    state.current.status = 'backlog';
    if (!state.queues.backlog.some((t) => t.id === state.current.id)) {
      state.queues.backlog.unshift(state.current);
    }
    state.current = null;
  }
  await git.ensureOnIntegration(GIT_ROOT, config.git.integrationBranch);
  // honor an outstanding rate-limit cooldown
  if (state.rateLimit.pausedUntil) {
    const wait = new Date(state.rateLimit.pausedUntil).getTime() - Date.now();
    if (wait > 0) { log(`Resuming after rate-limit cooldown (${Math.round(wait / 60000)} min)…`); await sleep(wait); }
    state.rateLimit.pausedUntil = null;
  }
  state.status = 'running';
  await saveState(STATE_PATH, state);
}

// ---------- top-level commands ----------
async function cmdInit() {
  await ensureDirs([STATE_DIR, HANDOFF_DIR]);
  if (existsSync(STATE_PATH)) {
    log('state.json already exists — refusing to overwrite. Delete autopilot/state/ to re-init.');
    return;
  }
  const state = await initState(STATE_PATH, config, seedBacklog(WORKSPACE.profile));
  await ensureDecisionLogHeader(STATE_DIR, state);
  await writeMirrors(STATE_DIR, state);
  log(`Initialized. Deadline: ${state.deadlineAt}. Backlog: ${state.queues.backlog.length} task(s).`);
  log('Start with: node autopilot/supervisor.mjs run');
}

// Replace the backlog with the fresh product-first seed, skipping anything already done/blocked.
// Preserves done/blocked history, stats, cycle counter, and the deadline.
async function cmdReprioritize() {
  if (!existsSync(STATE_PATH)) return log('No state yet. Run: node autopilot/supervisor.mjs init');
  const s = await loadState(STATE_PATH);
  const seenTitles = new Set([...s.queues.done, ...s.queues.blocked].map((t) => t.title));
  const fresh = seedBacklog(WORKSPACE.profile).filter((t) => !seenTitles.has(t.title));
  const before = s.queues.backlog.length;
  s.queues.backlog = fresh;
  await saveState(STATE_PATH, s);
  await writeMirrors(STATE_DIR, s);
  log(`Reprioritized backlog: ${before} → ${fresh.length} product-first task(s) (done/blocked preserved).`);
  await cmdRoute();
}

async function cmdRoute() {
  if (!existsSync(STATE_PATH)) return log('No state yet. Run: node autopilot/supervisor.mjs init');
  const s = await loadState(STATE_PATH);
  const ranked = rankBacklog(s.queues.backlog, config);
  console.log(`\nProduct-first ranking (${Math.round(productShare(s.queues.backlog) * 100)}% product):\n`);
  ranked.forEach((x, i) => console.log(`  ${i + 1}. ${x.task.id} [${x.cleanup ? 'cleanup' : 'product'}] score=${x.total} — ${x.task.title}\n      ${x.reason}`));
  const rows = s.queues.backlog.map((t) => ({ t, r: pickImplementerModel(t, config) }));
  const sonnet = rows.filter((x) => x.r.tier === 'sonnet');
  const opus = rows.filter((x) => x.r.tier === 'opus');
  console.log(`\nImplementer model routing for ${rows.length} backlog task(s):\n`);
  console.log(`── SONNET (low-risk engineering) — ${sonnet.length} task(s) ──`);
  for (const { t, r } of sonnet) console.log(`  ${t.id} [${t.goal}] ${t.title}\n      → ${r.reason}`);
  if (!sonnet.length) console.log('  (none)');
  console.log(`\n── OPUS (product/UX/arch/admin/social/stations or higher-risk) — ${opus.length} task(s) ──`);
  for (const { t, r } of opus) console.log(`  ${t.id} [${t.goal}] ${t.title}\n      → ${r.reason}`);
  console.log('\nSelector + Reviewer always run on Opus.\n');
}

async function cmdStatus() {
  log(`${describeWorkspace(WORKSPACE)}`);
  if (!existsSync(STATE_PATH)) return log(`No state yet for workspace "${WORKSPACE.id}". Run: node autopilot/supervisor.mjs init`);
  const s = await loadState(STATE_PATH);
  log(`status=${s.status} cycle=${s.cycle} phase=${s.goalPhase}`);
  log(`deadline=${s.deadlineAt} (${isPastDeadline(s) ? 'PASSED' : 'active'})`);
  log(`queues: backlog=${s.queues.backlog.length} done=${s.queues.done.length} blocked=${s.queues.blocked.length}`);
  const userPending = s.queues.backlog.filter((t) => t.userRequested);
  if (userPending.length) {
    log(`★ ${userPending.length} USER task(s) pending (built before auto tasks):`);
    for (const t of userPending) log(`   • ${t.id} ${t.title}`);
  }
  if (s.current?.userRequested) log(`★ currently building USER task ${s.current.id}: ${s.current.title}`);
  log(`stats:`, JSON.stringify(s.stats));
  if (config.weeklyBudget?.enabled && s.usage) {
    const u = s.usage;
    const tillReset = u.windowResetAt ? (new Date(u.windowResetAt).getTime() - Date.now()) / 86400000 : null;
    log(`weekly budget: ${u.cycles} cyc · $${(u.costUsd || 0).toFixed(2)} · ${Math.round(((u.inputTokens || 0) + (u.outputTokens || 0)) / 1000)}k tok this window`);
    const vf = Number(u.velocityFactor ?? 1);
    log(`  velocity: ${vf.toFixed(1)}x (${vf > 1 ? 'Throttled' : 'On Budget'}) · cadence ≤${config.weeklyBudget.maxCyclesPerDay}/day · resets ${u.windowResetAt || config.weeklyBudget.resetAt}${tillReset != null ? ` (in ${tillReset.toFixed(1)}d)` : ''}`);
  }
  log(`lessons learned: ${loadLessons(LESSONS_PATH, log).length} (autopilot/state/lessons.json)`);
  const running = existsSync(LOCK_PATH) && pidAlive((() => { try { return JSON.parse(readFileSync(LOCK_PATH, 'utf8')).pid; } catch { return 0; } })());
  log(`supervisor process: ${running ? 'RUNNING' : 'not running'}`);
  if (s.rateLimit.pausedUntil) log(`rate-limit paused until ${s.rateLimit.pausedUntil}`);
  // Budget governor snapshot (deterministic; spends no tokens).
  {
    const k = (n) => Number.isFinite(n) ? `${Math.round(n / 1000)}k` : '∞';
    const gov = governCycle(s, config, PROJECT_ID);
    log(`budget governor: ${gov.action.toUpperCase()} — spent ${k(gov.spent)}/${k(gov.quota)} tok · ~${gov.cyclesLeft} cycle(s) headroom · ${(gov.fractionUsed * 100).toFixed(0)}% of quota`);
    if (s.budget?.halted) log(`  ⚠ halted by budget governor (${s.budget.reason}) — resumes after window reset`);
  }
  const b = ensureBreaker(s); // display-only; cmdStatus never saves
  if (b && b.tripped) {
    log(`🛑 CIRCUIT BREAKER TRIPPED: ${b.reason} (at ${b.trippedAt}). Resume with: node autopilot/supervisor.mjs reset-breaker`);
  } else if (b) {
    log(`circuit breaker: armed (fails ${b.consecutiveFailures}/${config.circuitBreaker?.maxConsecutiveFailures ?? '-'} · rate-limits ${b.consecutiveRateLimits}/${config.circuitBreaker?.maxConsecutiveRateLimits ?? '-'} · churn ${b.consecutiveUnproductive}/${config.circuitBreaker?.maxConsecutiveUnproductive ?? '-'})`);
  }
}

// True if a process with this pid is currently alive.
function pidAlive(pid) {
  if (!pid) return false;
  try { process.kill(pid, 0); return true; }      // no signal sent; just checks existence
  catch (e) { return e.code === 'EPERM'; }          // EPERM = exists but not ours; ESRCH = gone
}

// Single-instance guard: refuse to start a 2nd supervisor on the same repo (two running = a git race
// that corrupts cycles — we hit this once, hard). Uses ATOMIC exclusive file creation (flag 'wx'),
// so even two supervisors started in the same instant cannot both win the lock — exactly one
// createFile succeeds; the loser sees EEXIST and refuses (or reclaims a provably-dead lock).
async function acquireLock() {
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      // O_EXCL: fails if the file already exists. This is the atomic primitive that closes the race.
      await writeFile(LOCK_PATH, JSON.stringify({ pid: process.pid, started: nowIso() }), { flag: 'wx' });
      break; // acquired
    } catch (e) {
      if (e.code !== 'EEXIST') {
        // Filesystem error (permissions, etc.) is a fatal engine fault.
        throw new LockError(
          `Supervisor failed to acquire its lock at "${LOCK_PATH}": ${e.message}. ` +
          `This is likely a permissions issue or the lock file is on a read-only filesystem.`,
          { cause: e }
        );
      }
      let prev = {};
      try { prev = JSON.parse(await readFile(LOCK_PATH, 'utf8')); } catch { /* unreadable */ }
      if (prev.pid && prev.pid !== process.pid && pidAlive(prev.pid)) {
        // Another supervisor is running — this is not a fatal error, just return false to exit gracefully.
        log(`Another supervisor is already running (pid ${prev.pid}, since ${prev.started}) — refusing to start (return).`);
        return false;
      }
      // Lock exists but its owner is gone (or it is ours) → reclaim it and retry the atomic create.
      log(`Found a stale lock (pid ${prev.pid ?? '?'} not running) — reclaiming.`);
      try { rmSync(LOCK_PATH); } catch { /* ignore */ }
      if (attempt === 1) { // couldn't reclaim after one retry — refuse rather than risk a double-run
        throw new LockError(
          `Supervisor could not acquire the lock safely after reclaim attempt. ` +
          `This suggests a race condition or a stale lock file that cannot be safely removed.`,
          { remediation: 'Verify no other supervisor process is running, then manually delete the lock file and retry.' }
        );
      }
    }
  }
  const release = () => {
    try {
      if (existsSync(LOCK_PATH)) {
        const l = JSON.parse(readFileSync(LOCK_PATH, 'utf8'));
        if (l.pid === process.pid) rmSync(LOCK_PATH);
      }
    } catch { /* ignore */ }
  };
  process.on('exit', release);
  process.on('SIGINT', release);
  process.on('SIGTERM', release);
  return true;
}

async function cmdRun() {
  // Make the active workspace explicit + visible BEFORE anything runs (Goal D), and self-check that the
  // operating root is inside the workspace's declared write boundary (Goal B/E — never act outside it).
  log(`▶ Active ${describeWorkspace(WORKSPACE)}`);
  for (const w of WORKSPACE_REGISTRY.warnings) log(`  workspace registry: ${w}`);
  assertWithinBoundary(WORKSPACE, GIT_ROOT, 'write'); // throws EngineError if GIT_ROOT escapes the boundary
  if (!existsSync(STATE_PATH)) { log(`No state for workspace "${WORKSPACE.id}". Run init first.`); return; }
  log(queuePathsResolvedLine());
  log(locksResolvedLine());
  log(gitConfigResolvedLine());
  log(budgetsResolvedLine());
  log(telemetryResolvedLine());
  log(apiPoolsResolvedLine());
  if (keyRotationActive()) log(`Key rotation engaged → ${keyManager.snapshot().filter((k) => k.hasToken).length} live key(s); ${keyRotation.maxRetries} rotations/call before backoff.`);
  log(handoffResolvedLine());
  log(handoffSchemaResolvedLine());
  // Fail fast with a descriptive EngineError if a required role prompt template is missing, instead of
  // letting renderPrompt() crash mid-cycle on a bare ENOENT after work has already started.
  requireLocalPath(PROMPT_DIR, 'prompt template directory');
  for (const role of ['selector', 'implementer', 'reviewer', 'auditor']) {
    requireLocalPath(path.join(PROMPT_DIR, `${role}.md`), `'${role}' role prompt template`);
  }
  await ensureDirs([STATE_DIR, HANDOFF_DIR]);
  await ensureInbox(INBOX_DIR);
  if (!(await acquireLock())) return;
  snapshotProtected(); // freeze a known-good copy of supervisor.mjs/watchdog.mjs (Strangler-Fig guard)
  let state = await loadState(STATE_PATH);
  ensureBreaker(state);

  // Circuit breaker: if a prior run tripped it, refuse to start until the operator clears it. This is
  // belt-and-suspenders with the STOP flag (the watchdog also stays down) so a manual `start` that
  // clears STOP without addressing the cause can't silently resume a halted loop.
  if (isTripped(state)) {
    log(`🛑 Circuit breaker is TRIPPED (${state.circuitBreaker.reason}). Refusing to start. Clear it with: node autopilot/supervisor.mjs reset-breaker`);
    return;
  }

  // Decoupled engine telemetry (U-36): bring up the independent metric/event recorder and emit the
  // startup event. Disabled by default → every recorder is a no-op, so this never alters loop behavior.
  initTelemetry(telemetryConfig);
  recordEvent('supervisor-startup', { projectId: PROJECT_ID, cycle: state.cycle, pid: process.pid });
  syncTelemetry(state);

  // graceful shutdown — state is already flushed each step, this just records intent
  let stopping = false;
  process.on('SIGINT', async () => {
    if (stopping) process.exit(1);
    stopping = true;
    log('SIGINT — finishing safely; state is on disk. Press Ctrl+C again to force.');
  });

  await recover(state);

  while (!isPastDeadline(state) && !stopping) {
    if (existsSync(STOP_FLAG)) { log('STOP flag detected — exiting at cycle boundary.'); break; }
    await paceForWeeklyBudget(state); // spread consumption to the weekly reset (shared account)
    if (existsSync(STOP_FLAG)) { log('STOP flag detected — exiting at cycle boundary.'); break; }
    // Circuit breaker: hard spend ceiling on the current window (checked before spending more).
    const costCheck = checkCostCeiling(state, config);
    if (costCheck.tripped) { await haltViaCircuitBreaker(state, costCheck.reason); break; }

    // BUDGET GOVERNOR (deterministic, pre-cycle): estimate the next cycle's cost and decide
    // proceed / downgrade / stop BEFORE spending. Persist the decision to state.budget for audit.
    const gov = governCycle(state, config, PROJECT_ID);
    state.budget = { action: gov.action, reason: gov.reason, spent: gov.spent, quota: gov.quota,
      quotaMode: gov.quotaMode, safeMode: gov.safeMode,
      usable: gov.usable, projected: gov.projected, estimate: gov.estimate, cyclesLeft: gov.cyclesLeft,
      fractionUsed: gov.fractionUsed, at: nowIso() };
    if (gov.action === 'stop') { await haltForBudget(state, gov); break; }
    log(`Budget governor → ${gov.action.toUpperCase()} [quota: ${gov.quotaMode}] — ${gov.reason}`);
    const cycleStartedAt = Date.now();
    recordEvent('cycle-start', { cycle: state.cycle + 1, projectId: PROJECT_ID });
    try {
      const { outcome } = await runCycle(state);
      // Circuit breaker: a 'merged' cycle is productive and clears the streaks; anything else
      // (blocked/re-queued/no-change) counts as churn. 'no-task' = empty backlog, 'architected' =
      // a planning cycle that just expanded the backlog — neither is churn, so skip the breaker.
      if (outcome !== 'no-task' && outcome !== 'architected') {
        const cb = recordCycleOutcome(state, config, outcome === 'merged' ? 'merged' : 'unproductive');
        if (cb.tripped) { await haltViaCircuitBreaker(state, cb.reason); break; }
      }
    } catch (err) {
      if (err instanceof RateLimitError) {
        recordEvent('error', { kind: 'rate-limit', cycle: state.cycle, message: err.message });
        const cb = recordCycleOutcome(state, config, 'rate-limit');
        if (cb.tripped) { await haltViaCircuitBreaker(state, cb.reason); break; }
        await pauseForRateLimit(state, err);
        continue;
      }
      // Non-fatal cycle error: roll back to snapshot, re-queue, keep the run alive.
      recordEvent('error', { kind: 'cycle-crash', cycle: state.cycle, message: err.message });
      recordEvent('cycle-end', { cycle: state.cycle, outcome: 'error',
        durationMs: Date.now() - cycleStartedAt, tokens: currentCycleTokens() });
      log(`⚠️  Cycle ${state.cycle} crashed (non-fatal, reverting to backlog): ${err.message}`);
      if (state.current) recordLesson(state.current, { failureType: 'crash', revisionCount: 0, validation: { summary: err.message }, review: { reasons: [err.message] } });
      if (state.current?.baseSha) await git.resetHard(GIT_ROOT, state.current.baseSha).catch(() => {});
      await git.ensureOnIntegration(GIT_ROOT, config.git.integrationBranch).catch(() => {});
      if (state.current) {
        state.current.status = 'backlog';
        state.queues.backlog.unshift(state.current);
        state.current = null;
      }
      await flushTelemetry();
      syncTelemetry(state);
      await saveState(STATE_PATH, state);
      // Circuit breaker: count this crash; trip if we're in a runaway error loop.
      const cb = recordCycleOutcome(state, config, 'crash');
      if (cb.tripped) { await haltViaCircuitBreaker(state, cb.reason); break; }
      await sleep(15000);
      continue;
    }
    state.rateLimit.consecutiveHits = 0;
    decreaseAdaptiveInterval(state);
    recordEvent('cycle-end', { cycle: state.cycle, outcome: 'ok',
      durationMs: Date.now() - cycleStartedAt, tokens: currentCycleTokens() });
    foldCycleUsage(state);
    const wu = ensureUsage(state);
    log(`Weekly usage: ${wu.cycles} cyc · $${wu.costUsd.toFixed(2)} · ${Math.round((wu.inputTokens + wu.outputTokens) / 1000)}k tok (resets ${wu.windowResetAt}).`);
    await flushTelemetry();
    syncTelemetry(state);
    await saveState(STATE_PATH, state);
    await sleep(config.cycle.cooldownBetweenCyclesMs);
  }

  state.status = 'done';
  recordEvent('supervisor-shutdown', { cycle: state.cycle, projectId: PROJECT_ID });
  await flushTelemetry();
  syncTelemetry(state);
  await saveState(STATE_PATH, state);
  await writeMirrors(STATE_DIR, state);
  log(isPastDeadline(state) ? '5-day deadline reached. Run complete.' : 'Stopped. Resume with: node autopilot/supervisor.mjs run');
}

// Drop a task into the inbox from the CLI (works while the loop is running — picked up next cycle).
//   node autopilot/supervisor.mjs add "make the leaderboard pulse when a team is overtaken"
async function cmdAdd() {
  const text = process.argv.slice(3).join(' ').trim();
  if (!text) {
    log('Usage: node autopilot/supervisor.mjs add "<what you want built>"');
    log('  Optional first lines inside a longer task:  goal: ui   risk: 2   effort: 2');
    process.exit(1);
  }
  await ensureInbox(INBOX_DIR);
  const file = await addInboxTask(INBOX_DIR, text);
  log(`📥 Queued user task → ${path.relative(REPO_ROOT, file)}`);
  log('It will be picked up at the start of the next cycle and built before any auto task.');
  if (existsSync(LOCK_PATH) && pidAlive(JSON.parse(readFileSync(LOCK_PATH, 'utf8')).pid || 0)) {
    log('A supervisor is running — it will ingest this automatically.');
  } else {
    log('No supervisor running — start it with:  node autopilot/supervisor.mjs run');
  }
}

// Stop the whole thing cleanly: raise the STOP flag (so the watchdog exits and does NOT restart),
// then terminate the running watchdog + supervisor. Resume later with `run` (or the watchdog/service).
async function cmdStop() {
  await ensureDirs([STATE_DIR]);
  await writeFile(STOP_FLAG, nowIso(), 'utf8');
  log('STOP flag raised — the watchdog will not restart the supervisor.');
  for (const [name, lock] of [['watchdog', WD_LOCK_PATH], ['supervisor', LOCK_PATH]]) {
    if (existsSync(lock)) {
      try {
        const { pid } = JSON.parse(readFileSync(lock, 'utf8'));
        if (pid && pidAlive(pid)) { process.kill(pid); log(`stopped ${name} (pid ${pid}).`); }
      } catch { /* ignore */ }
    }
  }
  log('Kinetic stopped. Restart anytime with: node autopilot/watchdog.mjs  (or supervisor.mjs run)');
}

// Turn the kinetic back ON after a stop: clear the STOP flag and launch the watchdog DETACHED
// (keeps running after this command returns / the terminal closes). The watchdog then keeps the
// supervisor alive forever.
async function cmdStart() {
  await ensureDirs([STATE_DIR]);
  if (existsSync(STOP_FLAG)) { rmSync(STOP_FLAG); log('Cleared STOP flag.'); }
  if (existsSync(WD_LOCK_PATH)) {
    try { const { pid } = JSON.parse(readFileSync(WD_LOCK_PATH, 'utf8')); if (pid && pidAlive(pid)) { log(`Watchdog already running (pid ${pid}).`); return; } } catch { /* stale */ }
  }
  const wd = path.join(__dirname, 'watchdog.mjs');
  const child = spawn(process.execPath, [wd], { cwd: REPO_ROOT, detached: true, stdio: 'ignore' });
  child.unref();
  log(`Watchdog started (detached, pid ${child.pid}). The kinetic will now run continuously.`);
  log('Stop anytime with: node autopilot/supervisor.mjs stop');
}

// Operator: clear a tripped circuit breaker. Resets the trip + all consecutive-failure streaks and
// removes the STOP flag the trip raised, so the loop can be resumed with `start` (or `run`).
async function cmdResetBreaker() {
  const state = await loadState(STATE_PATH);
  ensureBreaker(state);
  if (!state.circuitBreaker.tripped) { log('Circuit breaker is not tripped — nothing to reset.'); return; }
  const was = state.circuitBreaker.reason;
  resetBreaker(state);
  if (state.status === 'halted-circuit-breaker') state.status = 'running';
  await saveState(STATE_PATH, state);
  if (existsSync(STOP_FLAG)) { rmSync(STOP_FLAG); log('Cleared STOP flag.'); }
  log(`Circuit breaker reset (was: ${was}). Resume with: node autopilot/supervisor.mjs start`);
}

// Operator: reconcile state.json against the filesystem (disk is the source of truth). Dry-run by
// default — prints what it WOULD do. Pass --apply to mutate, --dedupe to also remove backlog duplicates.
//   node autopilot/supervisor.mjs reconcile            # report only
//   node autopilot/supervisor.mjs reconcile --apply    # demote falsely-done, unblock deadlock victims
async function cmdReconcile() {
  const apply = process.argv.includes('--apply');
  const dedupe = process.argv.includes('--dedupe');
  const state = await loadState(STATE_PATH);
  const report = analyzeState(state, config, REPO_ROOT);
  for (const line of formatReport(report).split('\n')) log(line);
  if (!apply) { log('\n(dry-run — re-run with --apply to make these changes' + (dedupe ? '' : '; add --dedupe to also remove duplicates') + ')'); return; }
  await writeFile(`${STATE_PATH}.pre-reconcile-${state.cycle}.bak`, JSON.stringify(state, null, 2), 'utf8').catch(() => {});
  const changed = applyReconciliation(state, report, { dedupe, stampCycle: state.cycle });
  await saveState(STATE_PATH, state);
  await writeMirrors(STATE_DIR, state).catch(() => {});
  log(`Applied: demoted ${changed.demotedDone.length} stale-done [${changed.demotedDone.join(', ') || '-'}]; ` +
      `unblocked ${changed.unblocked.length} for re-review [${changed.unblocked.join(', ') || '-'}]; ` +
      `resolved ${changed.dedConflicts.length} contradiction(s); deduped ${changed.deduped.length}.`);
  log('Backup written alongside state.json. Stale-blocked tasks are now in backlog with needsReReview (NOT marked done).');
}

// Operator: token-free verification — the deterministic budget decision + the non-LLM repo audit
// (duplicates, contradictions, stale done/blocked). Spends ZERO model tokens.
//   node autopilot/supervisor.mjs verify
async function cmdVerify() {
  const state = await loadState(STATE_PATH);
  const k = (n) => Number.isFinite(n) ? `${Math.round(n / 1000)}k` : '∞';
  const gov = governCycle(state, config, PROJECT_ID);
  log(`Budget governor → ${gov.action.toUpperCase()} — ${gov.reason}`);
  log(`  spent ${k(gov.spent)}/${k(gov.quota)} tok · usable ${k(gov.usable)} · est/next-cycle ${k(gov.estimate)} · ~${gov.cyclesLeft} cycle(s) of headroom`);
  const audit = nonLlmAudit(state, config, REPO_ROOT);
  log(`Non-LLM audit: ${audit.clean ? 'clean ✓' : 'ISSUES'}`);
  if (audit.duplicates.length) log(`  duplicates: ${audit.duplicates.map((d) => `${d.drop}≡${d.keep}`).join(', ')}`);
  if (audit.contradictions.length) log(`  contradictions: ${audit.contradictions.map((c) => c.id).join(', ')}`);
  if (audit.staleDone.length) log(`  stale-done (falsely certified): ${audit.staleDone.map((s) => s.id).join(', ')}`);
  if (audit.staleBlocked.length) log(`  stale-blocked (deadlock victims): ${audit.staleBlocked.map((s) => s.id).join(', ')}`);
  if (!audit.clean) log('  → run: node autopilot/supervisor.mjs reconcile [--apply]');
}

// ---------- entry ----------
const cmd = process.argv[2] || 'run';
try {
  if (cmd === 'init') await cmdInit();
  else if (cmd === 'status') await cmdStatus();
  else if (cmd === 'route') await cmdRoute();
  else if (cmd === 'reprioritize') await cmdReprioritize();
  else if (cmd === 'add') await cmdAdd();
  else if (cmd === 'stop') await cmdStop();
  else if (cmd === 'start') await cmdStart();
  else if (cmd === 'reset-breaker') await cmdResetBreaker();
  else if (cmd === 'reconcile') await cmdReconcile();
  else if (cmd === 'verify') await cmdVerify();
  else if (cmd === 'run' || cmd === 'resume') await cmdRun();
  else { log(`Unknown command "${cmd}". Use: start | stop | status | reset-breaker | reconcile [--apply] [--dedupe] | verify | add "task" | run | init | route | reprioritize`); process.exit(1); }
} catch (err) {
  const elapsedMs = Date.now() - supervisorStartedAt;
  const activeStep = cmd === 'run' ? 'main-loop' : `cmd-${cmd}`;
  const errorOutput = (err && err.code) ? formatEngineError(err, { elapsedMs, activeStep }) : '';
  log(errorOutput || `Fatal: ${err.stack || err.message}`);
  process.exit(1);
}
