// inbox.mjs — on-demand USER task injection.
//
// The user drops a task into autopilot/inbox/ at ANY time (even while the loop runs):
//   • a file:  autopilot/inbox/whatever.md   (first heading/line = title, rest = details)
//   • or CLI:  node autopilot/supervisor.mjs add "make the leaderboard pulse on overtake"
//
// At the start of every cycle the supervisor calls ingestInbox(): each new file becomes a
// high-priority task (userRequested:true → ranked ABOVE everything by score.mjs, and the selector
// is told to pick user tasks first), then the file is moved to inbox/processed/ so it is ingested
// exactly once. User tasks are never auto-dropped: a failed one is re-queued or blocked WITH a
// visible reason, never silently lost.
import { readdir, readFile, rename, mkdir, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { HANDOFF_SCHEMA_VERSION } from './handoff-schema.mjs';
import { PRIORITIES } from './priority.mjs';
import { isMacroVision } from './architect.mjs';

const TASK_EXTS = new Set(['.md', '.txt', '.task']);

// Parse one inbox file's raw text into { title, body }.
function parseTask(raw) {
  const lines = raw.replace(/\r\n/g, '\n').split('\n');
  let title = '';
  let firstIdx = -1;
  for (let i = 0; i < lines.length; i++) {
    const s = lines[i].trim();
    if (!s) continue;
    title = s.replace(/^#+\s*/, '').replace(/^[-*]\s*/, '').trim();
    firstIdx = i;
    break;
  }
  const body = firstIdx >= 0 ? lines.slice(firstIdx + 1).join('\n').trim() : '';
  return { title: title.slice(0, 300), body };
}

// Optional "key: value" front-matter the user can put at the top of a task file to steer it:
//   goal: ui | gameplay | admin | reliability | ...
//   risk: 1..5   effort: 1..5
// Case-SENSITIVE lowercase keys + a single-token, whitelisted goal value, so an uppercase "GOAL: ..."
// sentence in the prose body can never overwrite the real steering line.
const VALID_GOALS = new Set(['stations', 'access', 'builder', 'admin', 'review', 'social', 'gameplay', 'reliability', 'ui', 'structure', 'user', 'architecture', 'intelligence', 'optimization', 'infra', 'engine', 'migration', 'maintenance']);
function extractHints(body) {
  const hints = {};
  // Stage 2 adds two steering keys: `priority: high|medium|background` (the band) and
  // `architect: true|false` (force/forbid Architect-Mode decomposition of a macro-vision prompt).
  const re = /^[ \t]*(goal|risk|effort|priority|architect):[ \t]*([A-Za-z0-9-]+)[ \t]*$/gm; // no /i — lowercase keys only
  let m;
  while ((m = re.exec(body))) {
    const k = m[1];
    if (k === 'goal') {
      const g = m[2].toLowerCase().trim();
      if (VALID_GOALS.has(g)) hints.goal = g;        // ignore anything not a real category
    } else if (k === 'priority') {
      const p = m[2].toLowerCase().trim();
      if (PRIORITIES.includes(p)) hints.priority = p;
    } else if (k === 'architect') {
      const v = m[2].toLowerCase().trim();
      if (v === 'true' || v === 'false') hints.architect = v === 'true';
    } else {
      hints[k] = Math.max(1, Math.min(5, Number(m[2]) || 3));
    }
  }
  return hints;
}

export function ensureInbox(inboxDir) {
  return mkdir(path.join(inboxDir, 'processed'), { recursive: true });
}

// Append a task to the inbox from the CLI (`supervisor.mjs add "..."`). Returns the file path.
export async function addInboxTask(inboxDir, text, stampMs) {
  await ensureInbox(inboxDir);
  const safe = (text || '').trim();
  if (!safe) throw new Error('empty task text');
  // Deterministic-ish unique name from caller-supplied timestamp (Date.* is avoided elsewhere,
  // but the CLI is a one-shot human action so a real timestamp here is fine).
  const stamp = stampMs || Date.now();
  const slug = safe.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 40) || 'task';
  const file = path.join(inboxDir, `${stamp}-${slug}.md`);
  await writeFile(file, safe.endsWith('\n') ? safe : safe + '\n', 'utf8');
  return file;
}

// Read every un-processed inbox file, turn it into a high-priority user task, and move the file to
// processed/. Returns the array of new task objects (already shaped for the backlog). Pure of Date.*
// for resume-safety: the caller passes the current cycle; ids use a per-state sequence.
export async function ingestInbox(inboxDir, state, cycle) {
  await ensureInbox(inboxDir);
  let entries;
  try { entries = await readdir(inboxDir, { withFileTypes: true }); }
  catch { return []; }

  const files = entries
    .filter((e) => e.isFile() && TASK_EXTS.has(path.extname(e.name).toLowerCase()) && e.name.toLowerCase() !== 'readme.md')
    .map((e) => e.name)
    .sort(); // stable order = insertion order (timestamp-prefixed names sort chronologically)

  const created = [];
  for (const name of files) {
    const full = path.join(inboxDir, name);
    let raw = '';
    try { raw = await readFile(full, 'utf8'); } catch { continue; }
    const { title, body } = parseTask(raw);
    if (!title) { // empty/garbage file — archive it so we don't re-scan forever
      await rename(full, path.join(inboxDir, 'processed', name)).catch(() => {});
      continue;
    }
    const hints = extractHints(body);
    state.userTaskSeq = (state.userTaskSeq || 0) + 1;
    created.push({
      version: HANDOFF_SCHEMA_VERSION,   // versioned handoff envelope (U-34) — detectable on load/migration
      id: `U-${state.userTaskSeq}`,
      userTaskSeq: state.userTaskSeq,   // numeric FIFO key (id string-sort breaks at U-10+)
      goal: hints.goal || 'user',
      title,
      dims: { userImpact: 5, adminImpact: 3, reliability: 3, productRisk: 3, cleanupValue: 0 },
      risk: hints.risk ?? 3,
      effort: hints.effort ?? 3,
      deps: [],
      priority: hints.priority || 'medium',          // Stage 2 priority band (default medium)
      // Stage 2: macro-vision tasks ("build X from scratch") are flagged for Architect-Mode
      // decomposition. Explicit `architect:` front-matter wins; otherwise the heuristic decides.
      architect: hints.architect === true || (hints.architect !== false && isMacroVision(title + '\n' + body, hints)),
      source: 'user',
      userRequested: true,
      status: 'backlog',
      createdCycle: cycle,
      sourceFile: name,
      notes: body || '(no extra detail supplied)'
    });
    await rename(full, path.join(inboxDir, 'processed', name)).catch(() => {});
  }
  return created;
}
