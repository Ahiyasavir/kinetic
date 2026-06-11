// reconcile.mjs — make state.json honest against the filesystem. Disk is the source of truth.
//
// Four deterministic checks (report-first; mutation only in apply mode):
//   1. staleDone     — a DONE task whose declared artifacts are missing/unwired → it was NOT really
//                      done. Demote to blocked with a precise reason. (Truthfulness: never keep a
//                      falsely-certified task in done.)
//   2. staleBlocked  — a BLOCKED engine/maintenance/migration task that (a) was blocked for a STRUCTURAL
//                      reason (product-gate / no-diff / no-visible-change) AND (b) now has all artifacts
//                      present + wired → a deadlock victim. Move to backlog for RE-REVIEW under the
//                      class-aware gate. NEVER auto-marked done: files existing ≠ acceptance criteria met.
//   3. contradiction — same task id in two queues (or in a queue AND current). Report; apply keeps the
//                      most-progressed copy (current > done > blocked > backlog) and drops the rest.
//   4. duplicates    — near-duplicate titles within backlog. Report-only (dedup is destructive; the
//                      operator applies it explicitly via the CLI --dedupe flag).
//
// Pure logic over (state, config) + fs reads via evidence.checkEvidence. No Date/random.

import { classifyTask } from './task-class.mjs';
import { checkEvidence, hasStructuredArtifacts } from './evidence.mjs';

const STRUCTURAL_BLOCK = /product delivery gate|product-visible|player.?visible|no (visible )?(product )?change|no git diff|internal.only|categoryBonus=0|admin.?visible/i;

function norm(t) {
  return String(t || '').toLowerCase()
    .replace(/goal:\s*\w+/g, '').replace(/risk:\s*\d+/g, '').replace(/effort:\s*\d+/g, '')
    .replace(/[^a-z0-9]+/g, ' ').trim();
}

export function analyzeState(state, config, repoRoot) {
  const q = state.queues || {};
  const report = { staleDone: [], staleBlocked: [], contradictions: [], duplicates: [], scanned: 0 };

  // 1) staleDone — done tasks with declared artifacts that no longer verify.
  for (const t of q.done || []) {
    if (!hasStructuredArtifacts(t)) continue;           // only EXPLICIT artifacts justify a destructive demote
    report.scanned++;
    const ev = checkEvidence(t, repoRoot);
    if (!ev.ok) report.staleDone.push({ id: t.id, reason: ev.summary, missing: ev.missing, unwired: ev.unwired });
  }

  // 2) staleBlocked — structural-deadlock victims whose evidence is now present + wired.
  for (const t of q.blocked || []) {
    const cls = classifyTask(t, config);
    if (cls === 'product') continue;                    // product tasks legitimately need a visible diff
    const reason = `${t.blockReason || ''} ${t.lastFailure ? (t.lastFailure.reasons || []).join(' ') : ''}`;
    if (!STRUCTURAL_BLOCK.test(reason)) continue;       // only structural blocks are deadlock candidates
    if (!hasStructuredArtifacts(t)) continue;           // need EXPLICIT artifacts to prove the deadlock victim
    const ev = checkEvidence(t, repoRoot);
    if (ev.ok) report.staleBlocked.push({ id: t.id, class: cls, evidence: ev.summary });
  }

  // 3) contradictions — an id present in more than one place.
  const where = {};
  const places = [['current', state.current ? [state.current] : []], ['done', q.done || []], ['blocked', q.blocked || []], ['backlog', q.backlog || []]];
  for (const [name, arr] of places) for (const t of arr) {
    if (!t || !t.id) continue;
    (where[t.id] = where[t.id] || []).push(name);
  }
  for (const [id, locs] of Object.entries(where)) if (locs.length > 1) report.contradictions.push({ id, locations: locs });

  // 4) duplicates — near-duplicate titles within backlog.
  const seen = {};
  for (const t of q.backlog || []) {
    const n = norm(t.title);
    if (!n) continue;
    if (seen[n]) report.duplicates.push({ keep: seen[n], drop: t.id, title: String(t.title).slice(0, 70) });
    else seen[n] = t.id;
  }
  return report;
}

const PROGRESS_RANK = { current: 3, done: 2, blocked: 1, backlog: 0 };

// Mutates `state` per the report. Returns a summary of what changed. `opts.dedupe` enables the
// destructive backlog de-duplication (off by default). `stampCycle` is the cycle to record on changes.
export function applyReconciliation(state, report, opts = {}) {
  const q = state.queues;
  const changed = { demotedDone: [], unblocked: [], dedConflicts: [], deduped: [] };
  const cycle = opts.stampCycle ?? state.cycle ?? null;

  // 1) staleDone → blocked
  for (const s of report.staleDone) {
    const i = q.done.findIndex((t) => t.id === s.id);
    if (i < 0) continue;
    const [t] = q.done.splice(i, 1);
    t.status = 'blocked';
    t.blockReason = `reconcile: declared artifacts no longer verify (${s.reason})`;
    t.reconciledCycle = cycle;
    delete t.doneCycle;
    q.blocked.push(t);
    changed.demotedDone.push(s.id);
  }

  // 2) staleBlocked → backlog (for re-review; NOT done)
  for (const s of report.staleBlocked) {
    const i = q.blocked.findIndex((t) => t.id === s.id);
    if (i < 0) continue;
    const [t] = q.blocked.splice(i, 1);
    t.status = 'backlog';
    t.reconcileNote = `reconcile: artifacts present + wired (${s.evidence}); previously blocked for a structural reason. Re-review under the class-aware gate. NOT auto-marked done.`;
    t.needsReReview = true;
    t.reconciledCycle = cycle;
    delete t.blockReason;
    delete t.cooldownUntilCycle;
    q.backlog.push(t);
    changed.unblocked.push(s.id);
  }

  // 3) contradictions → keep most-progressed copy
  for (const c of report.contradictions) {
    let best = null, bestRank = -1;
    if (state.current && state.current.id === c.id) { best = 'current'; bestRank = PROGRESS_RANK.current; }
    for (const name of ['done', 'blocked', 'backlog']) {
      if ((q[name] || []).some((t) => t.id === c.id) && PROGRESS_RANK[name] > bestRank) { best = name; bestRank = PROGRESS_RANK[name]; }
    }
    for (const name of ['done', 'blocked', 'backlog']) {
      if (name === best) continue;
      const before = q[name].length;
      q[name] = q[name].filter((t) => t.id !== c.id);
      if (q[name].length !== before) changed.dedConflicts.push(`${c.id}@${name}`);
    }
  }

  // 4) duplicates (opt-in)
  if (opts.dedupe) {
    const dropIds = new Set(report.duplicates.map((d) => d.drop));
    if (dropIds.size) {
      q.backlog = q.backlog.filter((t) => !dropIds.has(t.id));
      changed.deduped = [...dropIds];
    }
  }
  return changed;
}

export function formatReport(report) {
  const lines = [];
  lines.push(`reconcile scan: ${report.scanned} done-task(s) with artifacts checked`);
  lines.push(`  stale DONE (falsely certified → demote to blocked): ${report.staleDone.length ? report.staleDone.map((s) => s.id).join(', ') : 'none ✓'}`);
  for (const s of report.staleDone) lines.push(`     - ${s.id}: ${s.reason}`);
  lines.push(`  stale BLOCKED (deadlock victim → unblock for re-review): ${report.staleBlocked.length ? report.staleBlocked.map((s) => s.id).join(', ') : 'none ✓'}`);
  for (const s of report.staleBlocked) lines.push(`     - ${s.id} [${s.class}]: ${s.evidence}`);
  lines.push(`  contradictions (id in >1 queue): ${report.contradictions.length ? report.contradictions.map((c) => `${c.id}(${c.locations.join('+')})`).join(', ') : 'none ✓'}`);
  lines.push(`  backlog duplicates: ${report.duplicates.length ? report.duplicates.map((d) => `${d.drop}≡${d.keep}`).join(', ') : 'none ✓'}`);
  return lines.join('\n');
}
