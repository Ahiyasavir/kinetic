// context-compiler.mjs — DETERMINISTIC file-relevance scoring run BEFORE an LLM implementer call.
// Goal: name the minimum set of repo files a task actually touches, so the implementer is pointed
// straight at them (a CONTEXT_HINT) instead of blind-exploring the whole tree. NO LLM is involved —
// this is a keyword/path-density ranking over `git ls-files`, reusing extractKeywords() from learn.mjs.
//
// It is purely ADVISORY: the hint is injected into the implementer prompt as guidance; the implementer
// still uses its own tools and may open anything. The compiler never restricts what the LLM can read,
// so it can only save tokens, never hide a needed file or weaken correctness.
//
// SCORING (first-pass path score is free; content is read only for the top path candidates):
//   pathScore    = Σ over task keywords of (basename-hit ? 3 : dir-hit ? 1 : 0)
//   contentScore = Σ over task keywords of min(occurrences-in-file, 5)        (capped, prevents one
//                  giant file dominating)
//   score        = pathScore × 4 + contentScore
// Files scoring 0 are excluded. The top `maxFiles` by score are returned with their match reasons.
//
// METRICS: originalBytes (Σ size of all scannable files) vs compiledBytes (Σ size of selected files),
// and reductionPct — the measurable shrink the hint represents versus dumping the whole tree.
import { execSync } from 'node:child_process';
import { readFileSync, statSync, existsSync } from 'node:fs';
import path from 'node:path';
import { extractKeywords } from './learn.mjs';

// Extensions worth scanning for source relevance (skip binaries, lockfiles, images, build output).
const SCAN_EXT = new Set([
  '.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs', '.json', '.md', '.css', '.scss',
  '.html', '.yml', '.yaml', '.sh', '.rules'
]);
const SKIP_DIR = /(^|\/)(node_modules|\.git|dist|build|lib|coverage|\.next|\.expo|\.firebase|out)(\/|$)/;
const SKIP_FILE = /(package-lock\.json|yarn\.lock|pnpm-lock\.yaml|\.min\.(js|css)$)/;
const MAX_CONTENT_BYTES = 200_000; // never read more than 200 KB of any single file for scoring

// List tracked files via git (deterministic, respects .gitignore). Injectable for tests.
export function defaultListFiles(repoRoot) {
  try {
    const out = execSync('git ls-files', { cwd: repoRoot, encoding: 'utf8', maxBuffer: 32 * 1024 * 1024 });
    return out.split('\n').map((s) => s.trim()).filter(Boolean);
  } catch {
    return [];
  }
}

function scannable(rel) {
  if (SKIP_DIR.test(rel) || SKIP_FILE.test(rel)) return false;
  return SCAN_EXT.has(path.extname(rel).toLowerCase());
}

// Count non-overlapping occurrences of a lowercase keyword in lowercase text (capped by the caller).
function countOccurrences(haystack, needle) {
  if (!needle) return 0;
  let n = 0, i = 0;
  while ((i = haystack.indexOf(needle, i)) !== -1) { n++; i += needle.length; }
  return n;
}

// Declared top-level symbol names (function/const/class/interface/type/enum, exported or not). Used to
// surface the SPECIFIC functions that make a file relevant — a higher-signal "why" than a raw word hit,
// and the thing the implementer actually wants pointed at. Advisory only; bounded so it stays cheap.
const SYMBOL_RE = /\b(?:export\s+)?(?:default\s+)?(?:async\s+)?(?:function\*?|const|let|var|class|interface|type|enum)\s+([A-Za-z_$][A-Za-z0-9_$]*)/g;
function matchingSymbols(text, keywords, max = 4) {
  const out = [];
  const seen = new Set();
  let m;
  SYMBOL_RE.lastIndex = 0;
  while ((m = SYMBOL_RE.exec(text)) && out.length < max) {
    const name = m[1];
    const lower = name.toLowerCase();
    if (seen.has(lower)) continue;
    if (keywords.some((kw) => lower.includes(kw))) { seen.add(lower); out.push(name); }
  }
  return out;
}

/**
 * Compile the minimum relevant-file context for a task.
 * @param {object}   opts
 * @param {object}   opts.task          { title, acceptanceCriteria[], notes, implementationHints[] }
 * @param {string}   opts.repoRoot      repo root for git ls-files + file reads
 * @param {number}   [opts.maxFiles=8]  max files to surface in the hint
 * @param {string[]} [opts.files]       pre-listed tracked files (tests inject; default = git ls-files)
 * @param {(rel:string)=>(string|null)} [opts.readText]  reader (tests inject; default = fs read)
 * @returns {{files:Array<{path,score,reasons:string[]}>, keywords:string[],
 *            metrics:{scanned:number,selected:number,originalBytes:number,compiledBytes:number,reductionPct:number}}}
 */
export function compileContext({ task, repoRoot, maxFiles = 8, files, readText } = {}) {
  const keywords = extractKeywords(
    `${task?.title || ''} ${(task?.acceptanceCriteria || []).join(' ')} ${task?.notes || ''} ${(task?.implementationHints || []).join(' ')}`,
    24
  );
  const empty = { files: [], keywords, metrics: { scanned: 0, selected: 0, originalBytes: 0, compiledBytes: 0, reductionPct: 0 } };
  if (!keywords.length) return empty;

  const list = (files || defaultListFiles(repoRoot)).filter(scannable);
  const read = readText || ((rel) => {
    try {
      const abs = path.join(repoRoot, rel);
      if (!existsSync(abs)) return null;
      const st = statSync(abs);
      if (!st.isFile() || st.size > MAX_CONTENT_BYTES * 4) return null; // skip huge files entirely
      return readFileSync(abs, 'utf8');
    } catch { return null; }
  });

  // ── Phase 1: free path-only scoring over every scannable file. ──
  let originalBytes = 0;
  const scored = [];
  for (const rel of list) {
    const lowerPath = rel.toLowerCase();
    const base = path.basename(lowerPath);
    const reasons = [];
    let pathScore = 0;
    for (const kw of keywords) {
      if (base.includes(kw)) { pathScore += 3; reasons.push(`name~${kw}`); }
      else if (lowerPath.includes(kw)) { pathScore += 1; reasons.push(`path~${kw}`); }
    }
    scored.push({ path: rel, pathScore, reasons });
  }

  // Estimate original size from the candidate pool (files we'd otherwise let the LLM scan). We sum
  // sizes lazily only for files we actually consider for content reading, to keep this bounded.
  // ── Phase 2: content-refine the top path candidates (bounded read set). ──
  // Read content for files with any path hit, plus enough top-of-list files to find content-only hits.
  const byPath = [...scored].sort((a, b) => b.pathScore - a.pathScore);
  const contentBudget = Math.max(maxFiles * 4, 40); // cap how many files we open for content scoring
  const considered = byPath.slice(0, contentBudget);
  for (const item of considered) {
    const txt = read(item.path);
    if (txt == null) { item.score = item.pathScore * 4; continue; }
    const head = txt.slice(0, MAX_CONTENT_BYTES);
    const lower = head.toLowerCase();
    let contentScore = 0;
    for (const kw of keywords) {
      const c = Math.min(countOccurrences(lower, kw), 5);
      if (c > 0) { contentScore += c; if (!item.reasons.some((r) => r.endsWith(kw))) item.reasons.push(`body~${kw}`); }
    }
    // Surface the specific matching symbols (functions/types) — a high-signal "why" + a small bonus, so
    // a file that DEFINES something the task names ranks above one that merely mentions the word.
    const syms = matchingSymbols(head, keywords);
    for (const s of syms) item.reasons.push(`fn:${s}`);
    contentScore += syms.length * 2;
    item.bytes = Buffer.byteLength(txt, 'utf8');
    originalBytes += item.bytes;
    item.score = item.pathScore * 4 + contentScore;
  }
  // Files beyond the content budget keep their path-only score (already set above for read==null path;
  // ensure every scored item has a numeric score).
  for (const item of scored) if (typeof item.score !== 'number') item.score = item.pathScore * 4;

  const ranked = scored
    .filter((s) => s.score > 0)
    .sort((a, b) => b.score - a.score || a.path.localeCompare(b.path))
    .slice(0, maxFiles);

  const compiledBytes = ranked.reduce((s, r) => s + (r.bytes || 0), 0);
  const reductionPct = originalBytes > 0
    ? Math.max(0, Math.round((1 - compiledBytes / originalBytes) * 100))
    : 0;

  return {
    files: ranked.map((r) => ({ path: r.path, score: r.score, reasons: [...new Set(r.reasons)].slice(0, 6) })),
    keywords,
    metrics: { scanned: list.length, selected: ranked.length, originalBytes, compiledBytes, reductionPct }
  };
}

// Render the compiled context as a CONTEXT_HINT prompt block (empty string when nothing scored, so the
// implementer prompt is unchanged in that case — backward compatible).
export function contextHintBlock(result) {
  if (!result || !result.files || !result.files.length) return '';
  const lines = result.files.map((f) => `  - ${f.path}  (${f.reasons.join(', ')})`);
  return [
    '## Likely-relevant files (deterministic pre-scan — advisory, not exhaustive)',
    'A keyword scan suggests these existing files are most relevant to this task. START here to save',
    'exploration, but you are NOT limited to them — open anything else you need:',
    ...lines,
    ''
  ].join('\n');
}
