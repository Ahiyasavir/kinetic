// audit.mjs — `autopilot audit` system self-check (U-63). Walks five diagnostic categories
// ([FILES], [CONFIG], [STATE], [GIT], [LOCKS]) using only Node built-ins (fs, path, child_process)
// and returns a structured result. It NEVER throws on missing/corrupt inputs — a missing file or
// malformed config is reported as a failed check so the audit always completes and stays grep-able.
//
//   import { runAudit, renderAudit } from './lib/audit.mjs';
//   const result = runAudit({ repoRoot, stateDir, statePath, configPath });
//   for (const line of renderAudit(result, { verbose: true })) console.log(line);

import { existsSync, readFileSync, statSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { formatSummary, formatVerbose } from './audit-formatter.mjs';

/** Safely read+parse a JSON file. Returns { ok, value?, error? } — never throws. */
function readJson(file) {
  try {
    const raw = readFileSync(file, 'utf8');
    if (!raw || !raw.trim()) return { ok: false, error: 'empty file' };
    return { ok: true, value: JSON.parse(raw) };
  } catch (e) {
    return { ok: false, error: e.code === 'ENOENT' ? 'missing' : e.message };
  }
}

/** Run git read-only and capture stdout. Returns { ok, out?, error? } — never throws. */
function git(args, cwd) {
  try {
    const r = spawnSync('git', args, { cwd, encoding: 'utf8' });
    if (r.error) return { ok: false, error: r.error.message };
    if (r.status !== 0) return { ok: false, error: (r.stderr || '').trim() || `exit ${r.status}` };
    return { ok: true, out: (r.stdout || '').trim() };
  } catch (e) {
    return { ok: false, error: e.message };
  }
}

/**
 * Run the full system audit. All inputs are injected paths so the audit is hermetic and testable.
 * @param {object} opts
 * @param {string} opts.repoRoot   repo root (git checks run here)
 * @param {string} opts.stateDir   per-workspace state directory
 * @param {string} opts.statePath  path to state.json
 * @param {string} opts.configPath path to config.json
 * @param {{supervisor?:string, watchdog?:string}} [opts.lockPaths] absolute lock file paths
 * @param {string} [opts.stopPath] path to the STOP flag file
 * @returns {{ ok:boolean, checks:Array<{category,message,status,detail?}> }}
 */
export function runAudit({ repoRoot, stateDir, statePath, configPath, lockPaths = {}, stopPath } = {}) {
  const checks = [];
  const add = (category, message, status, detail) => checks.push({ category, message, status, detail });

  // ── [FILES] key paths exist ───────────────────────────────────────────────
  const fileTargets = [
    ['repo root', repoRoot, true],
    ['state directory', stateDir, true],
    ['state.json', statePath, false],
    ['config.json', configPath, false]
  ];
  for (const [label, target, isDir] of fileTargets) {
    if (!target) { add('FILES', `${label} path not configured`, 'fail'); continue; }
    if (!existsSync(target)) { add('FILES', `${label} missing`, 'fail', target); continue; }
    let kind = 'exists';
    try { kind = statSync(target).isDirectory() ? 'directory' : 'file'; } catch { /* ignore */ }
    const mismatch = isDir && kind === 'file';
    add('FILES', `${label} present`, mismatch ? 'warn' : 'pass', kind);
  }

  // ── [CONFIG] config.json is valid + has core sections ─────────────────────
  const cfg = configPath ? readJson(configPath) : { ok: false, error: 'not configured' };
  if (!cfg.ok) {
    add('CONFIG', 'config.json unreadable', 'fail', cfg.error);
  } else {
    add('CONFIG', 'config.json is valid JSON', 'pass');
    for (const key of ['validation', 'budgets', 'paths']) {
      const present = Object.prototype.hasOwnProperty.call(cfg.value, key);
      add('CONFIG', `config.${key} ${present ? 'present' : 'absent'}`, present ? 'pass' : 'warn');
    }
    const cmds = cfg.value?.validation?.commands;
    add('CONFIG', `validation.commands ${Array.isArray(cmds) ? `(${cmds.length})` : 'not an array'}`,
      Array.isArray(cmds) && cmds.length > 0 ? 'pass' : 'warn');
  }

  // ── [STATE] state.json integrity ──────────────────────────────────────────
  // Handles both the two-tier schema (app.queues.{backlog,done,blocked}) and the legacy flat
  // { tasks: [...] } shape, so the audit stays correct across schema migrations.
  const st = statePath ? readJson(statePath) : { ok: false, error: 'not configured' };
  if (!st.ok) {
    add('STATE', 'state.json unreadable', 'fail', st.error);
  } else {
    add('STATE', 'state.json is valid JSON', 'pass');
    const v = st.value || {};
    const queues = v.app && v.app.queues;
    const flatTasks = Array.isArray(v.tasks) ? v.tasks : null;
    if (queues && (Array.isArray(queues.backlog) || Array.isArray(queues.done) || Array.isArray(queues.blocked))) {
      add('STATE', 'schema: two-tier (framework/app)', 'pass');
      const counts = {
        backlog: Array.isArray(queues.backlog) ? queues.backlog.length : 0,
        done: Array.isArray(queues.done) ? queues.done.length : 0,
        blocked: Array.isArray(queues.blocked) ? queues.blocked.length : 0
      };
      add('STATE', 'queue backlog', 'info', String(counts.backlog));
      add('STATE', 'queue done', 'info', String(counts.done));
      add('STATE', 'queue blocked', counts.blocked > 0 ? 'warn' : 'info', String(counts.blocked));
      const deadline = v.framework && v.framework.deadlineAt;
      add('STATE', `deadline ${deadline ? 'set' : 'unset'}`, deadline ? 'pass' : 'warn', deadline || undefined);
      const cycle = v.framework && v.framework.cycle;
      add('STATE', 'cycle', 'info', Number.isFinite(cycle) ? String(cycle) : 'unknown');
    } else if (flatTasks) {
      add('STATE', 'schema: flat (tasks array)', 'pass', `${flatTasks.length} task(s)`);
      const tally = { done: 0, blocked: 0, 'in-progress': 0, pending: 0, other: 0 };
      for (const t of flatTasks) {
        const s = t && t.status;
        if (Object.prototype.hasOwnProperty.call(tally, s)) tally[s]++;
        else tally.other++;
      }
      for (const s of ['done', 'in-progress', 'blocked', 'pending']) {
        add('STATE', `tasks ${s}`, 'info', String(tally[s]));
      }
      add('STATE', `deadline ${v.deadline ? 'set' : 'unset'}`, v.deadline ? 'pass' : 'warn', v.deadline || undefined);
    } else {
      add('STATE', 'no task queue found (expected app.queues or tasks)', 'fail');
    }
  }

  // ── [GIT] repository / HEAD / branch / cleanliness ────────────────────────
  if (!repoRoot) {
    add('GIT', 'repo root not configured', 'fail');
  } else {
    const inside = git(['rev-parse', '--is-inside-work-tree'], repoRoot);
    if (!inside.ok || inside.out !== 'true') {
      add('GIT', 'not a git repository', 'warn', inside.error || inside.out);
    } else {
      add('GIT', 'inside a git work tree', 'pass');
      const head = git(['rev-parse', '--short', 'HEAD'], repoRoot);
      add('GIT', `HEAD ${head.ok ? 'resolved' : 'unresolved'}`, head.ok ? 'pass' : 'fail', head.ok ? head.out : head.error);
      const branch = git(['rev-parse', '--abbrev-ref', 'HEAD'], repoRoot);
      add('GIT', `current branch`, branch.ok ? 'pass' : 'warn', branch.ok ? branch.out : branch.error);
      const status = git(['status', '--porcelain'], repoRoot);
      if (status.ok) {
        const dirty = status.out.length > 0;
        add('GIT', `work tree ${dirty ? 'has uncommitted changes' : 'clean'}`, dirty ? 'warn' : 'pass',
          dirty ? `${status.out.split('\n').length} file(s)` : undefined);
      } else {
        add('GIT', 'status unavailable', 'warn', status.error);
      }
    }
  }

  // ── [LOCKS] supervisor / watchdog locks + STOP flag ───────────────────────
  const lockTargets = [
    ['supervisor lock', lockPaths.supervisor],
    ['watchdog lock', lockPaths.watchdog]
  ];
  for (const [label, target] of lockTargets) {
    if (!target) { add('LOCKS', `${label} path not configured`, 'info'); continue; }
    const held = existsSync(target);
    add('LOCKS', `${label} ${held ? 'held' : 'free'}`, 'info', path.basename(target));
  }
  if (stopPath) {
    const stopped = existsSync(stopPath);
    add('LOCKS', `STOP flag ${stopped ? 'RAISED' : 'clear'}`, stopped ? 'warn' : 'pass');
  }

  const ok = checks.every((c) => c.status !== 'fail');
  return { ok, checks };
}

/** Render an audit result to operator-facing lines. verbose → per-check; otherwise → summary. */
export function renderAudit(result, { verbose = false } = {}) {
  return verbose ? formatVerbose(result.checks) : formatSummary(result.checks);
}
