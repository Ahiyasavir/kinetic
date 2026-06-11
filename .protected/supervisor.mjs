#!/usr/bin/env node
// supervisor.mjs — RushPoint Kinetic: a persistent external supervisor that runs Claude Opus 4.8 in
// repeated work cycles for five days. It selects the next task, has one agent implement it and another
// review it, validates, persists progress, pauses on rate limits, and resumes from disk after restart.
//
// Usage:
//   node autopilot/supervisor.mjs init     # seed state/ + starter backlog, set the 5-day deadline
//   node autopilot/supervisor.mjs run      # start / resume the autonomous loop (same command)
//   node autopilot/supervisor.mjs status   # print a snapshot without touching the loop

import { readFile, writeFile, rm, mkdir } from 'node:fs/promises';
import { existsSync, readFileSync, rmSync } from 'node:fs';
import {
  computeVelocityFactor, effectivePerDay, extractKeywords, bestLessonMatch, loadLessons, saveLessons
} from './lib/learn.mjs';
import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { ConfigError, StateError, LockError, OperationalError, formatEngineError } from './lib/engine-error.mjs';

import {
  GOAL_PHASES, emptyState, initState, loadState, saveState, ensureDirs,
  nextTaskId, isPastDeadline, nowIso, seedBacklog
} from './lib/state.mjs';
import { runClaude, RateLimitError } from './lib/claude.mjs';
import { pickImplementerModel } from './lib/route.mjs';
import { rankBacklog, scoreTask, isCleanup, isProduct, productShare } from './lib/score.mjs';
import * as git from './lib/git.mjs';
import { runValidation, countLintErrors } from './lib/validate.mjs';
import { writeMirrors, appendDecision, ensureDecisionLogHeader } from './lib/files.mjs';
import { ingestInbox, addInboxTask, ensureInbox } from './lib/inbox.mjs';
import { snapshotProtected } from './lib/protect.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '..');
const STATE_DIR = path.join(__dirname, 'state');
const HANDOFF_DIR = path.join(STATE_DIR, 'handoff');
const STATE_PATH = path.join(STATE_DIR, 'state.json');
const LESSONS_PATH = path.join(STATE_DIR, 'lessons.json');
const PROMPT_DIR = path.join(__dirname, 'prompts');
const INBOX_DIR = path.join(__dirname, 'inbox');
const LOCK_PATH = path.join(STATE_DIR, 'supervisor.lock');
const WD_LOCK_PATH = path.join(STATE_DIR, 'watchdog.lock');
const STOP_FLAG = path.join(STATE_DIR, 'STOP');
const CONFIG_PATH = path.join(__dirname, 'config.json');

let config;
try {
  const raw = await readFile(CONFIG_PATH, 'utf8');
  config = JSON.parse(raw);
} catch (err) {
  const message = err.code === 'ENOENT'
    ? `Config file not found at "${CONFIG_PATH}". This is required for the kinetic to run.`
    : `Config file at "${CONFIG_PATH}" is not valid JSON: ${err.message}`;
  throw new ConfigError(message, { cause: err, path: CONFIG_PATH });
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const localTs = () => new Date().toLocaleString('he-IL', { timeZone: 'Asia/Jerusalem', hour12: false,
  year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit' });
const log = (...a) => console.log(`[kinetic ${localTs()}]`, ...a);

// ---------- prompt rendering ----------
async function renderPrompt(name, vars) {
  let tpl = await readFile(path.join(PROMPT_DIR, `${name}.md`), 'utf8');
  for (const [k, v] of Object.entries(vars)) tpl = tpl.replaceAll(`{{${k}}}`, String(v));
  return tpl;
}

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

// Extract the first COMPLETE top-level JSON object from text, ignoring ```json fences and any prose
// before/after (a model sometimes appends "I've written the file. }"). Brace-balanced + string-aware
// so a `}` inside a string value or trailing prose can't truncate or over-extend the parse.
function extractJsonObject(text) {
  if (!text) return null;
  const s = text.indexOf('{');
  if (s < 0) return null;
  let depth = 0, inStr = false, esc = false;
  for (let i = s; i < text.length; i++) {
    const c = text[i];
    if (inStr) {
      if (esc) esc = false;
      else if (c === '\\') esc = true;
      else if (c === '"') inStr = false;
    } else if (c === '"') inStr = true;
    else if (c === '{') depth++;
    else if (c === '}') { depth--; if (depth === 0) return text.slice(s, i + 1); }
  }
  return null; // unbalanced — incomplete object
}

// Auto-drop guard: the selector occasionally proposes "build feature X" for an X that already ships
// on this branch. The quality gates would catch it, but that wastes cycles — so we reject obvious
// rebuilds up front. A title is a rebuild if it names a shipped feature WITHOUT a polish/improve intent.
const SHIPPED_FEATURE_RE = /smart.?station|auto.?verif|self.?(verif|confirm)|station verif|station builder|task editor|game builder|access.?code|control.?room|matchmaking|leaderboard|z.?score|race wrapped|\bwrapped\b|topographic|\bsos\b|\bpwa\b|tene|station review|station console|station operator|qr\W*(code)?\W*gener|gener\w*\W*(signed\W*)?(qr|code)|printable|station qr|camera qr|qr scan/i;
const POLISH_INTENT_RE = /polish|improv|refin|harden|clarity|loading|empty|error state|accessib|a11y|animat|feedback|translat|i18n|en\/he|\brtl\b|reconnect|offline|edge case|retr|indicator|banner|tooltip|guidance|next.?step|robust|\bfix\b/i;
function looksLikeRebuild(title) {
  const t = String(title || '');
  return SHIPPED_FEATURE_RE.test(t) && !POLISH_INTENT_RE.test(t);
}

// During a PRODUCTION HARDENING phase (config.phase === 'hardening') the user has locked the UI design
// and frozen new features: only resilience / concurrency / edge-case / validation / test work is allowed.
// This drops any auto-generated UI-polish or new-feature task (user inbox tasks are exempt).
const UI_POLISH_RE = /animat|confetti|pulse|entrance|transition|css|spacing|typograph|colou?r|gradient|micro.?interaction|tooltip|badge|podium|reveal|celebrat|haptic|visual|cosmetic|polish|skeleton|shimmer|theme|font|icon\b|emoji|sparkle|glow|fade|slide-?in|countdown timer|counter ticks/i;
const HARDENING_KEEP_RE = /harden|resilien|reconnect|offline|retry|backoff|transaction|concurren|race condition|idempoten|double.?(charge|complete|increment)|fallback|null|nan|validat|sanitiz|payload|edge.?case|timeout|error handling|unhandled|crash|recover|integrity|e2e|test coverage|robust|guard/i;
function looksLikeUiOrFeature(task) {
  const t = `${task.title || ''} ${task.notes || ''}`;
  if (HARDENING_KEEP_RE.test(t)) return false;          // explicitly hardening → keep
  if (task.goal === 'ui') return true;                  // UI category in hardening phase → drop
  return UI_POLISH_RE.test(t);                          // cosmetic keywords → drop
}

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

async function readHandoff(file) {
  const p = path.join(HANDOFF_DIR, file);
  if (!existsSync(p)) return null;
  try {
    const raw = await readFile(p, 'utf8');
    // 1) strict whole-file parse  2) fenced/embedded balanced object  3) fall back to slice
    try { return JSON.parse(raw.trim()); } catch { /* try extraction */ }
    const obj = extractJsonObject(raw);
    if (obj) { try { return JSON.parse(obj); } catch { /* fall through */ } }
    const start = raw.indexOf('{'), end = raw.lastIndexOf('}');
    if (start >= 0 && end > start) return JSON.parse(raw.slice(start, end + 1));
    return null;
  } catch { return null; }
}

async function clearHandoff() {
  await rm(HANDOFF_DIR, { recursive: true, force: true });
  await mkdir(HANDOFF_DIR, { recursive: true });
}

// ---------- one Claude role invocation ----------
async function invokeRole(name, vars, modelOverride) {
  const prompt = await renderPrompt(name, vars);
  const model = modelOverride || config.models?.[name] || config.model;
  log(`→ claude (${name} · ${model})`);
  const res = await runClaude({ prompt, cwd: REPO_ROOT, config, label: name, model });
  recordUsage(res); // self-meter tokens/cost for the weekly-budget pacer
  if (!res.ok) log(`  (${name} returned is_error; continuing to inspect handoff)`);
  return res;
}

// ---------- weekly usage self-metering ----------
// invokeRole() runs without a `state` handle, so per-call usage accumulates here and runCycle folds
// the cycle's total into state.usage on success (see the main loop).
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
      cycles: 0, calls: 0, inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheCreationTokens: 0, costUsd: 0
    };
  }
  return state.usage;
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
  _cycleUsage = null;
}

// ---------- failure-learning memory core ----------
// Keywords that represent a task for similarity matching (title + acceptance + notes).
function taskKeywords(task) {
  return extractKeywords(`${task.title || ''} ${(task.acceptanceCriteria || []).join(' ')} ${task.notes || ''}`);
}
// Persist a lesson from a failed/struggling cycle so a future similar task is flagged + de-risked.
// failureType ∈ 'blocked' | 'rollback' | 'high-revision' | 'crash'. Idempotent per (taskId, failureType).
function recordLesson(task, { failureType, revisionCount = 0, impl, validation, review }) {
  try {
    const lessons = loadLessons(LESSONS_PATH, log);
    if (lessons.some((l) => l.taskId === task.id && l.failureType === failureType)) return;
    const entry = {
      id: `L-${String(lessons.length + 1).padStart(4, '0')}`,
      timestamp: nowIso(),
      taskId: task.id,
      title: task.title || '',
      keywords: taskKeywords(task),
      failureType,
      revisionCount,
      filesInvolved: (impl?.filesChanged || []).slice(0, 20),
      errorSummary: ((review?.reasons || []).join('; ') || validation?.summary || '').slice(0, 500),
      avoidHints: [...(review?.requiredFixes || []), ...(task.lastFailure?.requiredFixes || [])]
        .filter(Boolean).slice(0, 8)
    };
    lessons.push(entry);
    saveLessons(LESSONS_PATH, lessons);
    log(`🧠 Recorded lesson ${entry.id} (${failureType}) for ${task.id} — keywords: ${entry.keywords.slice(0, 6).join(', ')}`);
  } catch (e) {
    log('lesson write error:', e.message);
  }
}

// ---------- a single improvement cycle ----------
async function runCycle(state) {
  state.cycle += 1;
  state.stats.cyclesRun += 1;
  await clearHandoff();
  resetCycleUsage(); // start a fresh per-cycle usage tally (folded into state.usage on success)
  log(`===== Cycle ${state.cycle} =====`);

  // INBOX: pull in any tasks the user dropped since last cycle. They go to the FRONT of the backlog
  // and (via score.mjs userBoost) outrank everything, so a user request is always picked next.
  let userTasks = [];
  try {
    userTasks = await ingestInbox(INBOX_DIR, state, state.cycle);
  } catch (e) {
    log(`⚠️  Inbox read error: ${e.message} — user tasks will not be ingested this cycle. Check ${INBOX_DIR}.`);
  }
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

  // Anti-churn: tasks that just failed are on a short cooldown — don't offer them as candidates this
  // cycle (so the loop progresses elsewhere), UNLESS every task is cooling down. User tasks never cool.
  const onCooldown = (t) => !t.userRequested && t.cooldownUntilCycle && state.cycle < t.cooldownUntilCycle;
  const selectable = state.queues.backlog.filter((t) => !onCooldown(t));
  const pool = selectable.length ? selectable : state.queues.backlog;

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
  await invokeRole('selector', {
    CANDIDATES: fmtRanked(ranked) || '(backlog empty)',
    WEAK_BACKLOG: weakNote,
    // Pass the FULL done/blocked history (titles only) so the selector never re-proposes an old
    // feature once the lists grow past a few dozen items over a long run.
    DONE: fmtTasks(state.queues.done, 300),
    BLOCKED: fmtTasks(state.queues.blocked, 300),
    NEXT_ID: nextTaskId(state),
    HANDOFF_PATH: path.join('kinetic', 'state', 'handoff', 'selection.json').replaceAll('\\', '/')
  });

  const selection = await readHandoff('selection.json');
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
  if (config.phase === 'hardening' && !task.userRequested && looksLikeUiOrFeature(task)) {
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
  state.current = task;
  await saveState(STATE_PATH, state);

  // Decide the implementer model for THIS task (Sonnet only for low-risk engineering).
  const route = pickImplementerModel(task, config);
  task.implementerModel = route.model;
  task.implementerTier = route.tier;
  task.implementerReason = route.reason;
  log(`Implementer model → ${route.tier.toUpperCase()} (${route.model}) — ${route.reason}`);

  // 2) SNAPSHOT + IMPLEMENT/REVIEW loop -----------------------------------
  // Work happens directly on the integration branch; we snapshot HEAD and, on any non-approval,
  // reset --hard back to it. No cycle branches (those raced with the implementer's own git in a
  // shared worktree and let unreviewed commits leak onto main).
  await git.ensureOnIntegration(REPO_ROOT, config.git.integrationBranch);
  const baseSha = await git.revParse(REPO_ROOT, 'HEAD');
  task.baseSha = baseSha;
  await saveState(STATE_PATH, state);

  // Lint-regression baseline: count existing ESLint errors on the CLEAN branch now, so the guard can
  // fail the cycle if the implementer INTRODUCES new ones (without punishing pre-existing debt).
  let lintBaseline = null;
  if (config.validation.lintRegressionGuard) {
    try { lintBaseline = await countLintErrors(config, REPO_ROOT); log(`Lint baseline: ${lintBaseline} pre-existing error(s).`); } catch { /* non-fatal */ }
  }

  const taskJson = JSON.stringify({
    id: task.id, title: task.title, goal: task.goal,
    acceptanceCriteria: task.acceptanceCriteria, implementationHints: task.implementationHints,
    rationale: task.rationale, downgradedFrom: task.downgradedFrom
  }, null, 2);

  let verdict = 'reject';
  let review = null;
  let impl = null;
  let attempt = 0;
  let validation = { ok: false, summary: 'not run' };
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

  while (attempt <= config.cycle.maxReviseAttempts) {
    // IMPLEMENT (model chosen by risk/category routing above)
    await invokeRole('implementer', {
      TASK_JSON: taskJson,
      CYCLE_BRANCH: config.git.integrationBranch,
      REVISION_BLOCK: revisionBlock,
      HANDOFF_PATH: path.join('kinetic', 'state', 'handoff', 'implementation.json').replaceAll('\\', '/')
    }, route.model);
    impl = await readHandoff('implementation.json');

    // Make sure we're back on the integration branch (the implementer may have switched branches)
    // and capture any uncommitted work it left behind. All commits accumulate on integration and
    // are rolled back to baseSha if the cycle isn't approved.
    await git.checkoutIntegrationKeepingWork(REPO_ROOT, config.git.integrationBranch);
    const autoCommitted = await git.commitAllIfDirty(REPO_ROOT, `${config.git.commitPrefix}: ${task.id} ${task.title}`);
    if (autoCommitted) log('Captured implementer changes on integration branch.');

    // VALIDATE (deterministic) — includes typecheck + admin build (required) + lint-regression guard
    log('Running validation…');
    validation = await runValidation(config, REPO_ROOT, lintBaseline);
    log(`Validation: ${validation.summary}`);

    // REVIEW (independent agent)
    await invokeRole('reviewer', {
      TASK_JSON: taskJson,
      IMPL_REPORT: JSON.stringify(impl || { summary: 'no handoff written' }, null, 2),
      VALIDATION: validation.summary + '\n' + validation.results.map((r) => `${r.name}: ${r.ok ? 'ok' : r.tail}`).join('\n'),
      INTEGRATION_BRANCH: config.git.integrationBranch,
      HANDOFF_PATH: path.join('kinetic', 'state', 'handoff', 'review.json').replaceAll('\\', '/')
    });
    review = await readHandoff('review.json');
    verdict = review?.verdict || 'reject';
    log(`Review verdict: ${verdict}`);

    if (verdict === 'approve' && validation.ok) {
      // CONSENSUS GATE: a SECOND, independent reviewer audits specifically for regressions, scope
      // creep, and broken existing behavior. We merge ONLY if both the reviewer AND the auditor
      // approve — the single biggest lever for trustworthy autonomous merges.
      await invokeRole('auditor', {
        TASK_JSON: taskJson,
        IMPL_REPORT: JSON.stringify(impl || { summary: 'no handoff' }, null, 2),
        VALIDATION: validation.summary,
        INTEGRATION_BRANCH: config.git.integrationBranch,
        HANDOFF_PATH: path.join('kinetic', 'state', 'handoff', 'audit.json').replaceAll('\\', '/')
      });
      const audit = await readHandoff('audit.json');
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
    } else if (verdict === 'reject') {
      break;
    }
    // verdict === 'revise' (or audit-driven revise, or approve-but-validation-failed) → bounded retry
    attempt += 1;
    state.stats.revisions += 1;
    if (attempt > config.cycle.maxReviseAttempts) break;
    const fixes = (review?.requiredFixes || []).join('\n - ') || 'Address the reviewer reasons and fix failing validation.';
    revisionBlock = `## Reviewer requested changes (revision ${attempt})\nFix these precisely, then re-commit:\n - ${fixes}\n` +
      (validation.ok ? '' : `\nValidation is currently FAILING: ${validation.summary}. Make it pass.\n`);
    log(`Revision ${attempt} requested.`);
  }

  // 3) FINALIZE -----------------------------------------------------------
  const approved = verdict === 'approve' && validation.ok;
  // Did the cycle actually produce committed work? (HEAD moved past the snapshot.)
  const headSha = await git.revParse(REPO_ROOT, 'HEAD');
  const hasWork = headSha !== baseSha;
  const diffStat = hasWork ? (await git.diffAgainst(REPO_ROOT, baseSha)).trim() : '';
  const appImpact = impl?.appImpact || impl?.summary || '(no impact statement)';
  let outcome;
  if (approved && hasWork) {
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
    task.status = 'done';
    task.doneCycle = state.cycle;
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
  } else if (approved && !hasWork) {
    // Approved but NOTHING was committed — the work didn't actually ship. Never mark this "done".
    task.noChangeAttempts = (task.noChangeAttempts || 0) + 1;
    if (task.noChangeAttempts >= config.scoring.maxAttemptsBeforeBlock) {
      task.status = 'blocked';
      task.blockReason = `produced no visible product change in ${task.noChangeAttempts} cycles — needs manual breakdown`;
      state.queues.blocked.push(task);
      state.stats.blocked += 1;
      outcome = 'blocked-no-change';
    } else {
      task.status = 'backlog';
      task.forceDowngrade = true;
      task.notes = (task.notes || '') + ` [retry ${task.noChangeAttempts}: shipped no visible change — BREAK INTO A SMALLER DELIVERABLE STEP that produces a user/admin-visible change this cycle]`;
      // Anti-churn: cool this task down for 2 cycles and send it to the BACK so the loop makes
      // progress on OTHER tasks instead of hammering the same stuck one cycle after cycle.
      task.cooldownUntilCycle = state.cycle + 5;
      state.queues.backlog.push(task);
      outcome = 're-queued-smaller';
    }
  } else {
    // Not approved → roll the integration branch back to the pre-cycle snapshot (discard all commits).
    await git.resetHard(REPO_ROOT, baseSha);
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
      if (task.reviewFailAttempts >= 2) {
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
  // churned through ≥3 revisions — so a future similar task is flagged + de-risked at pre-flight.
  {
    const revisionCount = attempt;
    let failureType = null;
    if (task.status === 'blocked') failureType = 'blocked';
    else if (!approved) failureType = 'rollback';
    else if (revisionCount >= 3) failureType = 'high-revision';
    if (failureType) recordLesson(task, { failureType, revisionCount, impl, validation, review });
  }

  // advance goal phase if recommended and backlog of this phase is thin
  if (selection.recommendedPhase && selection.recommendedPhase !== state.goalPhase &&
      GOAL_PHASES.includes(selection.recommendedPhase)) {
    state.goalPhase = selection.recommendedPhase;
    log(`Advancing goal phase → ${state.goalPhase}`);
  }

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

// ---------- rate-limit pause ----------
async function pauseForRateLimit(state, err) {
  state.rateLimit.consecutiveHits += 1;
  state.stats.rateLimitPauses += 1;
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
    if (state.current.baseSha) await git.resetHard(REPO_ROOT, state.current.baseSha).catch(() => {});
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
  const perDay = effectivePerDay(wb.maxCyclesPerDay, velocityFactor);
  if (velocityFactor > 1.0) log(`Velocity ${velocityFactor.toFixed(2)}x over budget — throttling cadence ${Math.max(1, Number(wb.maxCyclesPerDay) || 24)}→${perDay} cycles/day.`);
  const minSpacingMs = Math.round(86400000 / perDay);
  if (u.lastCycleAt) {
    const tillReset = new Date(u.windowResetAt).getTime() - Date.now();
    let waitMs = Math.min(minSpacingMs - (Date.now() - new Date(u.lastCycleAt).getTime()), Math.max(0, tillReset));
    if (waitMs > 0) {
      log(`Weekly-budget pacing: waiting ${Math.round(waitMs / 60000)} min (≤${perDay} cycles/day; ${u.cycles} done, ~$${u.costUsd.toFixed(2)} this window).`);
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
  await git.ensureIntegrationBranch(REPO_ROOT, config.git.integrationBranch, config.git.baseBranch);
  if (state.current) {
    log(`Recovering interrupted cycle: rolling back + re-queuing ${state.current.id}`);
    // Discard any partial commits from the interrupted cycle by resetting to its snapshot.
    if (state.current.baseSha) await git.resetHard(REPO_ROOT, state.current.baseSha).catch(() => {});
    state.current.status = 'backlog';
    if (!state.queues.backlog.some((t) => t.id === state.current.id)) {
      state.queues.backlog.unshift(state.current);
    }
    state.current = null;
  }
  await git.ensureOnIntegration(REPO_ROOT, config.git.integrationBranch);
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
  let state;
  try {
    state = await initState(STATE_PATH, config);
    await ensureDecisionLogHeader(STATE_DIR, state);
    await writeMirrors(STATE_DIR, state);
  } catch (err) {
    throw new StateError(
      `Failed to initialize supervisor state: ${err.message}. Check that ${STATE_DIR} is writable.`,
      { cause: err, path: STATE_PATH }
    );
  }
  log(`Initialized. Deadline: ${state.deadlineAt}. Backlog: ${state.queues.backlog.length} task(s).`);
  log('Start with: node autopilot/supervisor.mjs run');
}

// Replace the backlog with the fresh product-first seed, skipping anything already done/blocked.
// Preserves done/blocked history, stats, cycle counter, and the deadline.
async function cmdReprioritize() {
  if (!existsSync(STATE_PATH)) return log('No state yet. Run: node autopilot/supervisor.mjs init');
  const s = await loadState(STATE_PATH);
  const seenTitles = new Set([...s.queues.done, ...s.queues.blocked].map((t) => t.title));
  const fresh = seedBacklog().filter((t) => !seenTitles.has(t.title));
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
  if (!existsSync(STATE_PATH)) return log('No state yet. Run: node autopilot/supervisor.mjs init');
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
        throw new OperationalError(
          `Supervisor failed to acquire lock at "${LOCK_PATH}": ${e.message}. The lock file may be unwritable.`,
          { cause: e, operation: 'lock-acquire', remediation: `Check that ${path.dirname(LOCK_PATH)} exists and is writable. Ensure no other supervisor process is running.` }
        );
      }
      let prev = {};
      try { prev = JSON.parse(await readFile(LOCK_PATH, 'utf8')); } catch { /* unreadable */ }
      if (prev.pid && prev.pid !== process.pid && pidAlive(prev.pid)) {
        log(`REFUSING TO START: another supervisor is already running (pid ${prev.pid}, since ${prev.started}).`);
        log('Only ONE supervisor may run per repo. Stop it first, or delete autopilot/state/supervisor.lock if you are certain it is dead.');
        return false;
      }
      // Lock exists but its owner is gone (or it is ours) → reclaim it and retry the atomic create.
      log(`Found a stale lock (pid ${prev.pid ?? '?'} not running) — reclaiming.`);
      try { rmSync(LOCK_PATH); } catch { /* ignore */ }
      if (attempt === 1) { // couldn't reclaim after one retry — refuse rather than risk a double-run
        log('Could not acquire the lock safely — refusing to start.');
        return false;
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
  if (!existsSync(STATE_PATH)) { log('No state. Run init first.'); return; }
  await ensureDirs([STATE_DIR, HANDOFF_DIR]);
  await ensureInbox(INBOX_DIR);
  if (!(await acquireLock())) return;
  snapshotProtected(); // freeze a known-good copy of supervisor.mjs/watchdog.mjs (Strangler-Fig guard)
  let state;
  try {
    state = await loadState(STATE_PATH);
  } catch (err) {
    throw new StateError(
      `Failed to load supervisor state from "${STATE_PATH}": ${err.message}. The state file may be corrupted.`,
      { cause: err, path: STATE_PATH }
    );
  }

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
    const cycleStartMs = Date.now();
    try {
      await runCycle(state);
    } catch (err) {
      if (err instanceof RateLimitError) {
        await pauseForRateLimit(state, err);
        continue;
      }
      // Non-fatal cycle error: roll back to snapshot, re-queue, keep the run alive.
      const elapsedMs = Date.now() - cycleStartMs;
      const errContext = {
        elapsedMs,
        activeStep: `cycle ${state.cycle}`,
        lastState: state.current ? `working on ${state.current.id}` : 'between cycles'
      };
      if (err instanceof OperationalError || err instanceof StateError || err.code?.startsWith('ENGINE_')) {
        log(formatEngineError(err, errContext));
      } else {
        log(`⚠️  Cycle ${state.cycle} error (${Math.round(elapsedMs / 1000)}s): ${err.message}`);
        if (err.stack) log(err.stack);
      }
      if (state.current) recordLesson(state.current, { failureType: 'crash', revisionCount: 0, validation: { summary: err.message }, review: { reasons: [err.message] } });
      if (state.current?.baseSha) await git.resetHard(REPO_ROOT, state.current.baseSha).catch(() => {});
      await git.ensureOnIntegration(REPO_ROOT, config.git.integrationBranch).catch(() => {});
      if (state.current) {
        state.current.status = 'backlog';
        state.queues.backlog.unshift(state.current);
        state.current = null;
      }
      await saveState(STATE_PATH, state);
      await sleep(15000);
      continue;
    }
    state.rateLimit.consecutiveHits = 0;
    foldCycleUsage(state);
    const wu = ensureUsage(state);
    log(`Weekly usage: ${wu.cycles} cyc · $${wu.costUsd.toFixed(2)} · ${Math.round((wu.inputTokens + wu.outputTokens) / 1000)}k tok (resets ${wu.windowResetAt}).`);
    await saveState(STATE_PATH, state);
    await sleep(config.cycle.cooldownBetweenCyclesMs);
  }

  state.status = 'done';
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
  else if (cmd === 'run' || cmd === 'resume') await cmdRun();
  else { log(`Unknown command "${cmd}". Use: start | stop | status | add "task" | run | init | route | reprioritize`); process.exit(1); }
} catch (err) {
  // Format engine-level errors nicely; fall back to raw stack for unknown errors.
  if (err instanceof ConfigError || err instanceof StateError || err instanceof OperationalError ||
      err instanceof LockError || err.code?.startsWith('ENGINE_')) {
    console.error(formatEngineError(err, { activeStep: `${cmd} command` }));
  } else {
    log('Fatal (unknown error):', err.stack || err.message);
  }
  process.exit(1);
}
