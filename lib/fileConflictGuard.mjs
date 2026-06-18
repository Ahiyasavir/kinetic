// fileConflictGuard.mjs — U-67: file-conflict pre-flight guard for the Selector phase.
//
// Before the selector commits to a task, this runs a lightweight, dependency-free static scan: it
// extracts file-path references from the top-N backlog candidates' title + notes (anchored on the
// src/ | lib/ | apps/ | functions/ path roots) and compares them against the set of files already
// touched in the current cycle — the working-tree modified files surfaced by
// lib/select.mjs#getModifiedFilesDiffs. When a high-ranked candidate names a file that is ALREADY
// being modified, picking it risks colliding with in-flight edits, so we surface an advisory warning
// (logged + injected into the selector prompt).
//
// This is purely advisory and FAIL-OPEN: it never throws, never blocks a cycle, and never reorders the
// ranking. The selector stays the decision-maker; the guard only hands it one more signal. Every input
// is defended (non-strings, nulls, ranked-entry vs raw-task shapes) so a malformed candidate can never
// crash the selection step.

// Path-root segments that mark a token as a genuine source path (the U-67 spec regex: src/|lib/|apps/|functions/).
export const PATH_ANCHORS = ['src', 'lib', 'apps', 'functions'];

// A path-like token: ≥2 slash-separated segments of path-safe characters. Requiring a slash keeps prose
// words out; the ANCHOR_RE filter below then requires one of PATH_ANCHORS so "and/or" or "TODO/done"
// can't be mistaken for a file path.
const PATH_TOKEN_RE = /[A-Za-z0-9_@.\-]+(?:\/[A-Za-z0-9_@.\-]+)+/g;
const ANCHOR_RE = new RegExp(`(?:^|/)(?:${PATH_ANCHORS.join('|')})/`);

/**
 * Normalize a path reference for comparison: backslashes → forward slashes, drop a leading `./` or `/`,
 * and trim trailing slashes / stray dots. Returns '' for anything non-stringy.
 * @param {string} p
 * @returns {string}
 */
export function normalizeRefPath(p) {
  if (p == null) return '';
  let s = String(p).replace(/\\/g, '/').trim();
  s = s.replace(/^\.?\/+/, ''); // leading ./ or /
  s = s.replace(/\/+$/, '');    // trailing slash(es)
  s = s.replace(/\.+$/, '');    // trailing prose dot(s) the token regex may have swept up
  return s;
}

/**
 * Extract unique source-path references from free text (a candidate's title + notes). Only tokens that
 * contain one of PATH_ANCHORS as a path segment are returned.
 * @param {string} text
 * @returns {string[]}
 */
export function extractFileRefs(text) {
  if (typeof text !== 'string' || !text) return [];
  const out = new Set();
  const tokens = text.match(PATH_TOKEN_RE) || [];
  for (const raw of tokens) {
    const tok = normalizeRefPath(raw);
    if (!tok) continue;
    if (ANCHOR_RE.test('/' + tok)) out.add(tok);
  }
  return [...out];
}

function segListSuffix(longer, shorter) {
  if (!shorter.length || shorter.length > longer.length) return false;
  const tail = longer.slice(longer.length - shorter.length);
  return tail.every((seg, i) => seg === shorter[i]);
}

function segListPrefix(longer, shorter) {
  if (!shorter.length || shorter.length > longer.length) return false;
  return shorter.every((seg, i) => seg === longer[i]);
}

/**
 * Decide whether a (possibly partial) candidate reference points at the same file/dir as a touched
 * path. References in task notes are often partial (e.g. "src/pages/Foo.tsx" for the full
 * "apps/admin/src/pages/Foo.tsx"), so we treat the shorter segment list being a contiguous suffix
 * (file-level) OR prefix (directory-level) of the longer as a conflict.
 * @param {string} refPath
 * @param {string} touchedPath
 * @returns {boolean}
 */
export function pathsConflict(refPath, touchedPath) {
  const a = normalizeRefPath(refPath);
  const b = normalizeRefPath(touchedPath);
  if (!a || !b) return false;
  if (a === b) return true;
  const as = a.split('/');
  const bs = b.split('/');
  const [longer, shorter] = as.length >= bs.length ? [as, bs] : [bs, as];
  return segListSuffix(longer, shorter) || segListPrefix(longer, shorter);
}

// Coerce a candidate (a rankBacklog entry `{ task, ... }` OR a raw task object) into `{id, title, notes}`.
function normalizeCandidate(c) {
  if (!c || typeof c !== 'object') return null;
  const t = c.task && typeof c.task === 'object' ? c.task : c;
  return {
    id: t.id != null ? String(t.id) : '',
    title: typeof t.title === 'string' ? t.title : '',
    notes: typeof t.notes === 'string' ? t.notes : '',
  };
}

/**
 * Scan the top-N candidates for references to files already touched in the working tree.
 * @param {Array<object>} candidates  ranked entries (`{task}`) or raw task objects, highest-ranked first
 * @param {string[]} touchedFiles      repo-relative paths modified in the current cycle's working tree
 * @param {{topN?: number}} [opts]     how many top candidates to scan (default 3)
 * @returns {{scanned: number, conflicts: Array<{id, title, refs: string[], conflictingFiles: string[]}>, hasConflicts: boolean}}
 */
export function scanCandidateConflicts(candidates, touchedFiles, opts = {}) {
  const topN = Number.isInteger(opts.topN) && opts.topN > 0 ? opts.topN : 3;
  const list = (Array.isArray(candidates) ? candidates : []).slice(0, topN);
  const touched = (Array.isArray(touchedFiles) ? touchedFiles : [])
    .map(normalizeRefPath)
    .filter(Boolean);

  const conflicts = [];
  let scanned = 0;

  // No in-flight changes → nothing can conflict. (Still report scanned count for observability.)
  if (touched.length === 0) {
    for (const raw of list) if (normalizeCandidate(raw)) scanned++;
    return { scanned, conflicts: [], hasConflicts: false };
  }

  for (const raw of list) {
    const c = normalizeCandidate(raw);
    if (!c) continue;
    scanned++;
    const refs = extractFileRefs(`${c.title}\n${c.notes}`);
    if (!refs.length) continue;

    const conflictingFiles = new Set();
    const conflictingRefs = new Set();
    for (const ref of refs) {
      for (const f of touched) {
        if (pathsConflict(ref, f)) {
          conflictingFiles.add(f);
          conflictingRefs.add(ref);
        }
      }
    }
    if (conflictingFiles.size) {
      conflicts.push({
        id: c.id,
        title: c.title,
        refs: [...conflictingRefs],
        conflictingFiles: [...conflictingFiles],
      });
    }
  }

  return { scanned, conflicts, hasConflicts: conflicts.length > 0 };
}

/**
 * Render a conflict scan into a prompt/log-injectable warning block. Returns '' when there is no
 * conflict, so callers can inject it unconditionally (the selector template var is always defined).
 * @param {ReturnType<typeof scanCandidateConflicts>} scan
 * @returns {string}
 */
export function formatConflictWarnings(scan) {
  if (!scan || !scan.hasConflicts) return '';
  const lines = [
    '## ⚠️ FILE-CONFLICT PRE-FLIGHT WARNING',
    'These top candidate task(s) reference files that are ALREADY modified in the current working tree.',
    'Selecting one risks colliding with in-flight edits — prefer a candidate with NO file conflict, or',
    'confirm the overlap is intentional before picking it:',
  ];
  for (const c of scan.conflicts) {
    lines.push(`- ${c.id || '(no id)'} — "${c.title}": touches ${c.conflictingFiles.join(', ')}`);
  }
  return lines.join('\n');
}
