// file-conflict-guard.mjs — Selector pre-flight file-conflict guard (U-67).
//
// A lightweight static scan run after the Selector ranks the backlog but BEFORE the engine
// commits to implementing a task. It parses the top-N backlog candidates' title + notes for
// file-path references (src/ | lib/ | apps/ | functions/) and intersects them with the set of
// files already touched (modified vs HEAD) in the current working tree. An overlap means a
// candidate's likely edit surface collides with uncommitted in-flight work, which tends to
// produce merge/rebase churn — so the guard surfaces an advisory signal.
//
// It is NON-blocking by design: selection still proceeds. The result is logged and attached to
// state so the cycle log / dashboard can surface "the task you're about to start touches files
// that are already dirty". Pure functions, no I/O — the host supplies the touched-file list.

// Matches a relative path under one of the four well-known source roots. Stops at the first
// character that can't be part of a path token so trailing punctuation in prose is excluded.
const PATH_RE = /\b((?:src|lib|apps|functions)\/[A-Za-z0-9._-]+(?:\/[A-Za-z0-9._-]+)*)/g;

/**
 * Extract candidate source-file path references from free text (a task title or notes).
 * @param {string} text
 * @returns {string[]} de-duplicated, forward-slash path tokens (e.g. "lib/select.mjs")
 */
export function extractFilePaths(text) {
  if (!text || typeof text !== 'string') return [];
  const out = new Set();
  let m;
  PATH_RE.lastIndex = 0;
  while ((m = PATH_RE.exec(text)) !== null) {
    // Trim any trailing dot/punctuation a sentence may have appended.
    const p = m[1].replace(/[.,;:]+$/, '');
    if (p) out.add(p);
  }
  return [...out];
}

// A candidate path reference `ref` collides with a touched file `f` when they name the same
// file. Touched paths are repo-relative (e.g. "autopilot/lib/select.mjs") while candidate
// refs are usually root-relative (e.g. "lib/select.mjs"), so we accept a suffix match either way.
function pathsMatch(ref, file) {
  return file === ref || file.endsWith('/' + ref) || ref.endsWith('/' + file);
}

/**
 * Scan the top-N ranked candidates for path references that overlap the touched-file set.
 *
 * @param {Array<{task?:object}|object>} candidates  ranked entries ({task,...}) or raw task objects
 * @param {Iterable<string>} touchedFiles            files modified in the working tree
 * @param {{topN?:number}} [opts]
 * @returns {{conflicts:Array<{id:string,title:string,refs:string[],files:string[]}>, scanned:number, touchedCount:number}}
 */
export function scanCandidateConflicts(candidates, touchedFiles, opts = {}) {
  const topN = Math.max(1, opts.topN ?? 3);
  const touched = [...(touchedFiles || [])]
    .map((f) => String(f).replace(/\\/g, '/').trim())
    .filter(Boolean);

  if (!touched.length) return { conflicts: [], scanned: 0, touchedCount: 0 };

  const top = (Array.isArray(candidates) ? candidates : []).slice(0, topN);
  const conflicts = [];

  for (const entry of top) {
    const task = entry?.task || entry || {};
    const refs = extractFilePaths(`${task.title || ''}\n${task.notes || ''}`);
    if (!refs.length) continue;

    const files = new Set();
    for (const ref of refs) {
      for (const f of touched) if (pathsMatch(ref, f)) files.add(f);
    }
    if (files.size) {
      conflicts.push({ id: task.id, title: task.title, refs, files: [...files] });
    }
  }

  return { conflicts, scanned: top.length, touchedCount: touched.length };
}

/**
 * One-line human summary for the cycle log (empty string when there's no conflict).
 * @param {ReturnType<typeof scanCandidateConflicts>} result
 * @returns {string}
 */
export function formatConflictWarning(result) {
  if (!result?.conflicts?.length) return '';
  return result.conflicts
    .map((c) => `⚠ candidate ${c.id || '?'} (“${c.title || ''}”) references already-modified files: ${c.files.join(', ')}`)
    .join('\n');
}
