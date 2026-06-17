// usage-reader.mjs — TRUE, account-wide token-usage measurement from Claude Code's own transcripts.
//
// WHY THIS EXISTS (the problem it fixes):
//   The engine previously tracked only the tokens IT spent (state.usage counters from each `claude -p`
//   call). But the Anthropic account is SHARED with the user's interactive Claude sessions — those burn
//   the same 5-hour and weekly limits yet were completely invisible to the engine. Result: the dashboard
//   showed ~23% while the real account was at ~75–128%, the governor paced against a fiction, and the
//   only patch was a manual `/api/calibrate` the user had to re-enter every week.
//
//   Claude Code writes a JSONL transcript for EVERY session (engine + interactive) under
//   ~/.claude/projects/**/*.jsonl. Each assistant turn records its exact token usage. Summing across all
//   of them — deduped by message-id:request-id — yields the TRUE account-wide usage, no calibration
//   needed. This is the same ground-truth source the Claude-Code-Usage-Monitor project reads.
//
// WHAT IT MEASURES (cache-inclusive — Claude's limits count cache tokens at full value):
//   tokens = input + output + cache_creation_input + cache_read_input
//
// PERFORMANCE: the UI polls usage every few seconds and the transcript tree is ~150MB across ~300 files.
//   Re-reading everything each poll would be wasteful, so per-file parse results are MEMOIZED by
//   (mtimeMs,size): only files that actually changed since the last call are re-read. A poll then costs
//   one stat() per file plus a re-parse of just the 1–2 transcripts being actively appended.

import { readdirSync, readFileSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';

export const FIVE_HOUR_MS = 5 * 60 * 60 * 1000;
export const SEVEN_DAY_MS = 7 * 24 * 60 * 60 * 1000;

// Default transcript root. Override via the CLAUDE_PROJECTS_DIR env var or the opts.projectsDir arg
// (the latter is used by tests against a fixture directory).
export function defaultProjectsDir() {
  return process.env.CLAUDE_PROJECTS_DIR || path.join(homedir(), '.claude', 'projects');
}

// Per-file parse cache: absolute path → { key, entries }. `key` is `${mtimeMs}:${size}` so any append
// (mtime + size both move) invalidates it. `entries` is a compact array of { ts, tokens, hash }.
const _fileCache = new Map();

function listJsonlFiles(dir) {
  let out = [];
  let dirents;
  try { dirents = readdirSync(dir, { withFileTypes: true }); }
  catch { return out; } // missing/unreadable dir → no files (caller degrades to zeros)
  for (const e of dirents) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) out = out.concat(listJsonlFiles(p));
    else if (e.name.endsWith('.jsonl')) out.push(p);
  }
  return out;
}

// Pull the cache-inclusive token total + dedup key + timestamp out of one parsed JSONL record.
// Returns null when the line carries no usage (user turns, summaries, malformed rows).
export function extractEntry(rec) {
  if (!rec || typeof rec !== 'object') return null;
  const msg = rec.message;
  const usage = (msg && msg.usage) || rec.usage;
  if (!usage || typeof usage !== 'object') return null;

  const input = Number(usage.input_tokens) || 0;
  const output = Number(usage.output_tokens) || 0;
  const cacheCreate = Number(usage.cache_creation_input_tokens) || 0;
  const cacheRead = Number(usage.cache_read_input_tokens) || 0;
  const tokens = input + output + cacheCreate + cacheRead;
  if (tokens <= 0) return null;

  const ts = Date.parse(rec.timestamp);
  if (!Number.isFinite(ts)) return null;

  // Dedup key: the same assistant message can appear in more than one transcript (resume/branch).
  const messageId = rec.message_id || (msg && msg.id) || null;
  const requestId = rec.requestId || rec.request_id || null;
  const hash = messageId && requestId ? `${messageId}:${requestId}` : null;

  const model = (msg && msg.model) || rec.model || 'unknown';
  return { ts, tokens, hash, model, input, output, cacheCreate, cacheRead };
}

function parseFile(filePath) {
  let raw;
  try { raw = readFileSync(filePath, 'utf8'); } catch { return []; }
  const entries = [];
  for (const line of raw.split('\n')) {
    if (!line) continue;
    let rec;
    try { rec = JSON.parse(line); } catch { continue; }
    const e = extractEntry(rec);
    if (e) entries.push(e);
  }
  return entries;
}

// Load every usage entry across the transcript tree, using the mtime/size memo so unchanged files are
// not re-read. Returns a flat array of entries (NOT deduped yet — dedup happens in the aggregate).
function loadAllEntries(projectsDir) {
  const files = listJsonlFiles(projectsDir);
  const seenPaths = new Set(files);
  const all = [];
  for (const f of files) {
    let key;
    try { const st = statSync(f); key = `${st.mtimeMs}:${st.size}`; } catch { continue; }
    let cached = _fileCache.get(f);
    if (!cached || cached.key !== key) {
      cached = { key, entries: parseFile(f) };
      _fileCache.set(f, cached);
    }
    for (const e of cached.entries) all.push(e);
  }
  // Evict cache entries for files that disappeared (e.g. cleaned-up old projects).
  for (const k of _fileCache.keys()) if (!seenPaths.has(k)) _fileCache.delete(k);
  return all;
}

/**
 * Measure true account-wide usage.
 *
 * @param {object}  [opts]
 * @param {number}  [opts.nowMs]          injectable clock (tests); defaults to Date.now()
 * @param {number}  [opts.weeklyStartMs]  start of the FIXED weekly window (state.usage.windowStartedAt).
 *                                         When omitted, the weekly figure falls back to a rolling 7-day sum.
 * @param {string}  [opts.projectsDir]    transcript root override (tests / non-default installs)
 * @returns {{
 *   weekly: { tokens:number, entries:number },
 *   fiveHour: { tokens:number, entries:number, resetAtMs:number, msLeft:number },
 *   byModel: Record<string,number>,
 *   files: number, available: boolean, at: number
 * }}
 */
export function measureUsage(opts = {}) {
  const nowMs = opts.nowMs || Date.now();
  const projectsDir = opts.projectsDir || defaultProjectsDir();
  const weeklyStartMs = Number.isFinite(opts.weeklyStartMs) ? opts.weeklyStartMs : (nowMs - SEVEN_DAY_MS);
  const fiveHourCutoff = nowMs - FIVE_HOUR_MS;

  const entries = loadAllEntries(projectsDir);

  const seen = new Set();
  let weeklyTokens = 0, weeklyEntries = 0;
  let fiveTokens = 0, fiveEntries = 0;
  let oldestFiveTs = nowMs;
  const byModel = {};

  for (const e of entries) {
    if (e.hash) { if (seen.has(e.hash)) continue; seen.add(e.hash); }
    if (e.ts >= weeklyStartMs) {
      weeklyTokens += e.tokens;
      weeklyEntries++;
      byModel[e.model] = (byModel[e.model] || 0) + e.tokens;
    }
    if (e.ts >= fiveHourCutoff) {
      fiveTokens += e.tokens;
      fiveEntries++;
      if (e.ts < oldestFiveTs) oldestFiveTs = e.ts;
    }
  }

  // Rolling 5h window: pressure eases when the oldest in-window entry ages out.
  const resetAtMs = fiveEntries > 0 ? oldestFiveTs + FIVE_HOUR_MS : nowMs;

  return {
    weekly: { tokens: weeklyTokens, entries: weeklyEntries },
    fiveHour: { tokens: fiveTokens, entries: fiveEntries, resetAtMs, msLeft: Math.max(0, resetAtMs - nowMs) },
    byModel,
    files: _fileCache.size,
    available: entries.length > 0,
    at: nowMs,
  };
}

// Test/maintenance hook: drop the per-file memo so the next measureUsage() re-reads from disk.
export function _resetCache() { _fileCache.clear(); }
