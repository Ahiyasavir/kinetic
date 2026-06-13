// blocked-reviewer.mjs — U-71: Haiku-powered blocked-queue auto-review.
//
// Every N cycles (config.blockedReview.intervalCycles, default 10), if blocked tasks exist,
// this agent invokes a cheap Haiku call per blocked task asking: "given what changed in the
// codebase since this task was blocked, is it safe to retry it?"  A 'yes' verdict moves the
// task back to the backlog; a 'no' leaves it blocked.
//
// Wire-in: call runBlockedReview(state, config, gitRoot, log) from supervisor.mjs during
// the inter-cycle cooldown (next to runIdleScanner). It is a no-op when the interval hasn't
// elapsed, when blocked is empty, or when config.blockedReview.enabled is false.

import { execFile } from 'node:child_process';

const AGENT_ID = 'blocked-reviewer';

// Recent git log since a given ISO timestamp, summarized for context.
async function gitLogSince(cwd, sinceIso, maxLines = 20) {
  return new Promise((resolve) => {
    execFile(
      'git', ['log', `--since=${sinceIso}`, '--oneline', `--max-count=${maxLines}`],
      { cwd, maxBuffer: 512 * 1024 },
      (err, stdout) => resolve(err ? '(git log unavailable)' : (stdout.trim() || '(no commits since block)'))
    );
  });
}

// Build the one-shot prompt for a single blocked task.
function buildPrompt(task, recentLog) {
  const blockedAt = task.blockedAt || task.doneCycle ? `cycle ${task.doneCycle}` : 'unknown cycle';
  return `You are a triage agent reviewing a BLOCKED engineering task.

TASK ID: ${task.id}
TITLE: ${task.title}
BLOCKED REASON: ${task.blockReason || '(no reason recorded)'}
BLOCKED AT: ${blockedAt}

RECENT GIT CHANGES since the task was blocked:
${recentLog}

QUESTION: Given the reason this task was blocked AND what has changed in the codebase since,
should this task be retried now?

Answer with EXACTLY one of these two JSON objects (nothing else):
{ "retry": true,  "reason": "<one sentence why it can now succeed>" }
{ "retry": false, "reason": "<one sentence why it should stay blocked>" }

Be conservative — only return retry:true if the block reason is clearly resolved by the changes above.`;
}

// Parse the Haiku response. Returns { retry: bool, reason: string } or null on parse failure.
function parseResponse(raw) {
  if (!raw || typeof raw !== 'string') return null;
  const trimmed = raw.trim();
  // The Claude CLI JSON output wraps the model reply in { result: "..." }
  let text = trimmed;
  try {
    const outer = JSON.parse(trimmed);
    if (outer && typeof outer.result === 'string') text = outer.result.trim();
  } catch { /* raw text mode */ }

  // Extract the first JSON object from the text
  const match = text.match(/\{[^{}]*"retry"\s*:\s*(true|false)[^{}]*\}/);
  if (!match) return null;
  try {
    return JSON.parse(match[0]);
  } catch {
    return null;
  }
}

// Spawn a one-shot Haiku call. Returns the raw stdout string.
function spawnHaiku(prompt, config, log) {
  const model = (config.blockedReview && config.blockedReview.model) || config.models?.auditor || 'claude-haiku-4-5';
  const bin = (config.cli && config.cli.bin) || 'claude';
  const permission = (config.cli && config.cli.permission) || '--dangerously-skip-permissions';
  const timeoutMs = (config.blockedReview && config.blockedReview.timeoutMs) || 60000;

  return new Promise((resolve) => {
    const child = execFile(
      bin,
      ['-p', '--model', model, '--output-format', 'json', permission],
      { shell: true, timeout: timeoutMs, maxBuffer: 256 * 1024 },
      (err, stdout) => {
        if (err) {
          log(`[${AGENT_ID}] Haiku call error: ${err.message}`);
          resolve(null);
        } else {
          resolve(stdout || null);
        }
      }
    );
    child.stdin.write(prompt);
    child.stdin.end();
  });
}

// ---------- PUBLIC API ----------

// Should the blocked reviewer run this cycle?
export function shouldRunBlockedReview(state, config) {
  const cfg = config.blockedReview || {};
  if (cfg.enabled === false) return false;
  if (!state.queues || !state.queues.blocked || state.queues.blocked.length === 0) return false;
  const interval = cfg.intervalCycles ?? 10;
  return state.cycle > 0 && state.cycle % interval === 0;
}

// Main entry: review blocked tasks and unblock eligible ones.
//   state   — live engine state (mutated in-place: blocked → backlog)
//   config  — loaded engine config
//   gitRoot — absolute path to the git working tree
//   log     — the supervisor log function
// Returns: { reviewed: number, unblocked: string[], kept: string[] }
export async function runBlockedReview(state, config, gitRoot, log) {
  const blocked = state.queues && state.queues.blocked ? [...state.queues.blocked] : [];
  if (blocked.length === 0) return { reviewed: 0, unblocked: [], kept: [] };

  log(`[${AGENT_ID}] Reviewing ${blocked.length} blocked task(s) (cycle ${state.cycle})…`);

  const unblocked = [];
  const kept = [];

  for (const task of blocked) {
    // Get recent git log since this task was blocked (use blockedAt ISO or fallback to last 7d)
    const sinceIso = task.blockedAt || new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString();
    const recentLog = await gitLogSince(gitRoot, sinceIso);

    const prompt = buildPrompt(task, recentLog);
    const raw = await spawnHaiku(prompt, config, log);
    const verdict = parseResponse(raw);

    if (!verdict) {
      log(`[${AGENT_ID}]   ${task.id}: parse failure — leaving blocked`);
      kept.push(task.id);
      continue;
    }

    if (verdict.retry) {
      log(`[${AGENT_ID}]   ${task.id}: UNBLOCK — ${verdict.reason}`);
      // Move from blocked to backlog
      const idx = state.queues.blocked.indexOf(task);
      if (idx !== -1) state.queues.blocked.splice(idx, 1);
      task.status = 'backlog';
      task.blockReason = undefined;
      task.needsReReview = true;
      task.unblockReason = verdict.reason;
      task.unblockCycle = state.cycle;
      // Reset attempt counters so a fresh attempt isn't penalized by old failures
      task.reviewFailAttempts = 0;
      task.noChangeAttempts = 0;
      state.queues.backlog.push(task);
      if (state.stats) state.stats.blocked = Math.max(0, (state.stats.blocked || 0) - 1);
      unblocked.push(task.id);
    } else {
      log(`[${AGENT_ID}]   ${task.id}: stay blocked — ${verdict.reason}`);
      kept.push(task.id);
    }
  }

  log(`[${AGENT_ID}] Done: ${unblocked.length} unblocked [${unblocked.join(', ')||'-'}], ${kept.length} kept blocked.`);
  return { reviewed: blocked.length, unblocked, kept };
}

export default { runBlockedReview, shouldRunBlockedReview };
