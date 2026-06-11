// validate.mjs — run the project's own validation commands deterministically (no Claude involved).
// The validation commands themselves are project config, not engine code: they live in
// config.json → validation and are surfaced through the non-protected config-loader seam (U-26).
//
// SHA-keyed cache: project commands (typecheck/build/lint) are deterministic on a given git tree, so
// revision loops that commit nothing re-use the cached result instead of running a 2–10 min toolchain
// again. The engine guardrails (kinetic-syntax, protected-core) run every time; they are fast and
// guard the kinetic's own source which the implementer could modify between calls.
import { exec } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { checkKineticSyntax, verifyProtected } from './protect.mjs';
import { validation as defaultValidation, lintCommand } from '../config-loader.mjs';

// In-process cache: keyed by `${headSha}:${lintBaseline}:${configHash}`. Cleared on process start.
// Object.create(null) to avoid prototype-chain collisions.
const _cache = Object.create(null);

// P5 — optional PERSISTENT cache (survives process restarts). The in-process cache above is the fast
// L1 layer; when a `cacheFile` is supplied, results also persist to that JSON file (L2) so a supervisor
// restart on the SAME git tree skips the 2–10 min toolchain again. Auto-invalidation is structural: the
// key embeds the HEAD SHA *and* a hash of the validation config, so any repo change (new commit) or
// toolchain change (different commands) produces a different key — a stale entry is never matched, only
// ignored. Bounded LRU (default 100 entries) keeps the file small.
const PERSIST_VERSION = 1;
const PERSIST_MAX = 100;

// Deterministic hash of the validation-affecting config so a changed toolchain invalidates the cache.
function configHashOf(config) {
  const v = (config && config.validation) || defaultValidation || {};
  const shape = {
    commands: (v.commands || []).map((c) => ({ name: c.name, cmd: c.cmd, required: !!c.required })),
    lintRegressionGuard: !!v.lintRegressionGuard,
    e2e: v.e2e ? { enabled: !!v.e2e.enabled, cmd: v.e2e.cmd } : null,
  };
  return createHash('sha256').update(JSON.stringify(shape)).digest('hex').slice(0, 12);
}

// Load the persistent cache file (graceful: missing/corrupt → empty, never throws into the loop).
function loadPersistent(cacheFile) {
  if (!cacheFile || !existsSync(cacheFile)) return { version: PERSIST_VERSION, entries: {}, order: [] };
  try {
    const d = JSON.parse(readFileSync(cacheFile, 'utf8'));
    if (!d || d.version !== PERSIST_VERSION || typeof d.entries !== 'object') throw new Error('shape');
    if (!Array.isArray(d.order)) d.order = Object.keys(d.entries);
    return d;
  } catch {
    return { version: PERSIST_VERSION, entries: {}, order: [] };
  }
}

// Store an entry in the persistent file under LRU eviction (best-effort; a write failure is non-fatal).
function savePersistent(cacheFile, key, entry) {
  if (!cacheFile) return;
  try {
    const d = loadPersistent(cacheFile);
    if (!d.entries[key]) d.order.push(key);
    else d.order = d.order.filter((k) => k !== key).concat(key);
    d.entries[key] = entry;
    while (d.order.length > PERSIST_MAX) {
      const evict = d.order.shift();
      if (evict !== key) delete d.entries[evict];
    }
    writeFileSync(cacheFile, JSON.stringify(d), 'utf8');
  } catch { /* best effort — persistence never blocks validation */ }
}

// A signature of the EXACT working-tree state validation would run against, or null if git is
// unavailable / not a repo (→ no caching, the safe fallback). The HEAD SHA alone is NOT enough: the
// implementer can leave UNCOMMITTED edits or new files, and a stale HEAD would then mask changed code
// behind a prior PASS. So the signature folds in the commit identity AND the uncommitted delta:
//   • `git rev-parse HEAD`     — the committed baseline
//   • `git status --porcelain` — the set of modified / added / deleted / untracked paths
//   • `git diff HEAD`          — the content of all tracked modifications
// A clean tree → empty status+diff → the signature reduces to (essentially) the HEAD SHA, so the
// committed-and-unchanged revision-loop case still caches exactly as before. Any working-tree change
// (commit, edit, add, delete) changes the signature → cache miss → fresh validation. (Residual: editing
// an UNTRACKED file's contents without a path change is not captured; the always-run engine syntax gate
// still covers the engine tree, and such files are outside the committed product surface.)
function treeSignature(cwd) {
  const sh = (cmd, timeoutMs) => new Promise((resolve) => {
    exec(cmd, { cwd, timeout: timeoutMs, maxBuffer: 64 * 1024 * 1024 }, (err, stdout) => resolve(err ? null : (stdout || '')));
  });
  return (async () => {
    const head = await sh('git rev-parse HEAD', 5000);
    if (head == null) return null; // not a git repo / git unavailable → caller disables caching
    const status = await sh('git status --porcelain', 10000);
    const diff = await sh('git diff HEAD', 15000);
    // If either dirty-state probe failed, refuse to cache rather than risk a stale clean-looking key.
    if (status == null || diff == null) return null;
    return createHash('sha256').update(head.trim()).update('\0').update(status).update('\0').update(diff).digest('hex').slice(0, 24);
  })();
}

// Exported for tests: flush the in-process cache between test cases.
export function clearValidationCache() { for (const k of Object.keys(_cache)) delete _cache[k]; }

// Exported for tests/maintenance: wipe the persistent cache file (best effort).
export function clearPersistentValidationCache(cacheFile) {
  if (!cacheFile) return;
  try { writeFileSync(cacheFile, JSON.stringify({ version: PERSIST_VERSION, entries: {}, order: [] }), 'utf8'); } catch { /* ignore */ }
}

function run(cmd, cwd, timeoutMs) {
  return new Promise((resolve) => {
    exec(cmd, { cwd, timeout: timeoutMs, maxBuffer: 32 * 1024 * 1024, shell: true }, (err, stdout, stderr) => {
      resolve({
        ok: !err,
        code: err ? err.code ?? 1 : 0,
        full: stdout + '\n' + stderr,
        tail: (stdout + '\n' + stderr).slice(-2000)
      });
    });
  });
}

// Total ESLint *error* count across all workspaces, parsed from "✖ N problems (E errors, W warnings)".
// Used by the regression guard: the implementer may not INCREASE the error count — pre-existing debt is
// tolerated, newly-introduced lint errors are not.
export async function countLintErrors(config, cwd) {
  const v = config.validation || defaultValidation;
  const lintCmd = (v.commands.find((c) => c.name === 'lint') || {}).cmd || lintCommand();
  if (!lintCmd) return 0; // no lint command configured for this project — nothing to count.
  const r = await run(lintCmd, cwd, 600000);
  let total = 0;
  const re = /\((\d+)\s+errors?/g;
  let m;
  while ((m = re.exec(r.full))) total += Number(m[1]);
  return total;
}

/**
 * Run all configured validation commands. A failing `required` command fails the whole run;
 * a failing non-required command is reported as a warning but does not block.
 * @param {number|null} lintBaseline  if a number and lintRegressionGuard is on, fail when the current
 *                                    lint error count exceeds this baseline (a regression introduced now).
 * @param {{cacheFile?:string}} [opts] P5 — optional persistent-cache file path. When set, project-command
 *                                    results survive process restarts (keyed by SHA + config hash).
 * @returns {Promise<{ok:boolean, results:Array, summary:string, lintErrors:number|null, cached:boolean}>}
 */
export async function runValidation(config, cwd, lintBaseline = null, opts = {}) {
  const cacheFile = opts.cacheFile || null;
  const v = config.validation || defaultValidation;
  const results = [];
  let ok = true;
  let lintErrors = null;

  // === Engine guardrails (always run — fast, guard the kinetic's own source) ===
  // 1) Hard syntax gate on the whole engine.
  const syn = checkKineticSyntax();
  if (!syn.ok) {
    ok = false;
    results.push({ name: 'kinetic-syntax', required: true, ok: false, code: 1,
      tail: 'Engine .mjs syntax error(s):\n' + syn.failures.map((f) => `${f.file}: ${f.err}`).join('\n') });
  }
  // 2) Frozen core: reject unauthorized edits to supervisor.mjs/watchdog.mjs.
  const prot = verifyProtected();
  if (prot.violated) {
    ok = false;
    results.push({ name: 'protected-core', required: true, ok: false, code: 1,
      tail: `Reverted unauthorized change to FROZEN engine file(s): ${prot.files.join(', ')}. ` +
            `supervisor.mjs and watchdog.mjs may not be modified until autopilot/core/.ready exists ` +
            `(Strangler-Fig). Build the new engine under autopilot/core/ instead.` });
  }

  // === Project commands (typecheck / build / lint) — tree-signature-keyed cache ===
  // The toolchain is deterministic on a given working tree. A revision loop that changes nothing
  // produces the same tree signature → cache hit → skip the 2–10 min re-run; ANY change (commit or
  // uncommitted edit/add/delete) changes the signature → fresh run. Engine guardrails above are
  // excluded from caching because they must re-check the engine source on every call.
  const sig = await treeSignature(cwd); // worktree-aware: commit + uncommitted delta (null = no caching)
  const cfgHash = configHashOf(config);
  const cacheKey = sig ? `${sig}:${lintBaseline ?? ''}:${cfgHash}` : null;
  // L1 (in-process) first; on an L1 miss consult L2 (persistent file) and warm L1 from it.
  let cached = cacheKey ? _cache[cacheKey] : null;
  let fromPersistent = false;
  if (!cached && cacheKey && cacheFile) {
    const p = loadPersistent(cacheFile).entries[cacheKey];
    if (p) { cached = p; _cache[cacheKey] = p; fromPersistent = true; }
  }
  if (cached) {
    // Re-use project results from the cache. Engine-guardrail results (already pushed above) still
    // combine correctly because ok starts false when an engine check failed.
    results.push(...cached.results);
    if (!cached.ok) ok = false;
    lintErrors = cached.lintErrors;
  } else {
    const projResults = [];
    let projOk = true;

    for (const c of v.commands) {
      const r = await run(c.cmd, cwd, c.timeoutMs || 600000);
      projResults.push({ name: c.name, required: c.required, ok: r.ok, code: r.code, tail: r.tail });
      if (!r.ok && c.required) projOk = false;
      if (c.name === 'lint') {
        lintErrors = 0;
        const re = /\((\d+)\s+errors?/g; let m;
        while ((m = re.exec(r.full))) lintErrors += Number(m[1]);
      }
    }

    // Regression guard: block a cycle that INCREASES the ESLint error count.
    let lintRegressed = false;
    if (v.lintRegressionGuard && lintBaseline != null && lintErrors != null && lintErrors > lintBaseline) {
      lintRegressed = true;
      projOk = false;
      projResults.push({ name: 'lint-regression', required: true, ok: false, code: 1,
        tail: `Implementer introduced lint errors: ${lintBaseline} → ${lintErrors}. Fix the new errors.` });
    }

    if (v.e2e?.enabled) {
      const r = await run(v.e2e.cmd, cwd, v.e2e.timeoutMs || 600000);
      projResults.push({ name: 'e2e', required: true, ok: r.ok, code: r.code, tail: r.tail });
      if (!r.ok) projOk = false;
    }

    if (cacheKey) {
      const entry = { ok: projOk, results: projResults, lintErrors, lintRegressed };
      _cache[cacheKey] = entry;       // L1
      savePersistent(cacheFile, cacheKey, entry); // L2 (no-op when cacheFile is null)
    }
    if (!projOk) ok = false;
    results.push(...projResults);
  }

  const lintRegressed = cached ? !!cached.lintRegressed : results.some((r) => r.name === 'lint-regression' && !r.ok);
  const summary = results
    .map((r) => `${r.ok ? 'PASS' : 'FAIL'} ${r.name}${r.required ? '' : ' (non-blocking)'}`)
    .join(' · ') + (lintErrors != null ? ` · lint-errors=${lintErrors}${lintBaseline != null ? `/base ${lintBaseline}` : ''}` : '')
    + (cached ? (fromPersistent ? ' [cache-hit:persistent]' : ' [cache-hit]') : '');

  return { ok, results, summary, lintErrors, lintRegressed, cached: !!cached, persistent: fromPersistent };
}
