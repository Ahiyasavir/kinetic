// audit.test.mjs — node:test suite for the `autopilot audit --verbose` self-check (U-63).
// Hermetic: every case builds a throwaway temp workspace on disk, so no real state/config is touched.
//   node --test autopilot/tests/audit.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { runAudit, renderAudit } from '../lib/audit.mjs';
import { formatLine, formatSummary, formatVerbose } from '../lib/audit-formatter.mjs';
import { CATEGORIES } from '../lib/audit-categories.mjs';

/** Build a temp workspace; `opts` controls which artifacts exist / are valid. */
function makeWorkspace(opts = {}) {
  const root = mkdtempSync(path.join(tmpdir(), 'audit-test-'));
  const stateDir = path.join(root, 'state');
  mkdirSync(stateDir, { recursive: true });
  const statePath = path.join(stateDir, 'state.json');
  const configPath = path.join(root, 'config.json');

  if (opts.config !== 'missing') {
    const cfg = opts.config === 'malformed'
      ? '{ this is not json'
      : JSON.stringify({ validation: { commands: ['npm run typecheck'] }, budgets: {}, paths: {} });
    writeFileSync(configPath, cfg);
  }
  if (opts.state !== 'missing') {
    const st = opts.state === 'malformed'
      ? '{ broken'
      : JSON.stringify({ tasks: [{ id: 'A', status: 'done' }, { id: 'B', status: 'pending' }], deadline: '2026-12-31' });
    writeFileSync(statePath, st);
  }
  return { root, repoRoot: root, stateDir, statePath, configPath };
}

function cleanup(ws) { rmSync(ws.root, { recursive: true, force: true }); }

// 1) --verbose flag → renderAudit emits one line per check (20+) with [CATEGORY] prefixes.
test('verbose output emits 20+ prefixed diagnostic lines', () => {
  const ws = makeWorkspace();
  try {
    const result = runAudit({ ...ws, lockPaths: {}, stopPath: path.join(ws.stateDir, 'STOP') });
    const lines = renderAudit(result, { verbose: true });
    assert.ok(lines.length >= 20, `expected >=20 verbose lines, got ${lines.length}`);
    for (const line of lines) {
      assert.match(line, /^\[(FILES|CONFIG|STATE|GIT|LOCKS)\] /, `line missing category prefix: ${line}`);
    }
    // every category should appear at least once
    for (const cat of CATEGORIES) {
      assert.ok(lines.some((l) => l.startsWith(`[${cat}]`)), `missing category ${cat}`);
    }
  } finally { cleanup(ws); }
});

// 2) Non-verbose summary is substantially shorter than verbose (backward-compatible roll-up).
test('summary view is shorter than verbose view', () => {
  const ws = makeWorkspace();
  try {
    const result = runAudit({ ...ws });
    const summary = renderAudit(result, { verbose: false });
    const verbose = renderAudit(result, { verbose: true });
    assert.ok(summary.length < verbose.length, 'summary should have fewer lines than verbose');
    // one roll-up per category that has checks, plus an overall line
    for (const line of summary) {
      assert.match(line, /^\[(FILES|CONFIG|STATE|GIT|LOCKS)\] /);
    }
  } finally { cleanup(ws); }
});

// 3) Missing state.json is reported verbosely as a STATE failure (graceful, no throw).
test('missing state file is reported as a STATE failure, not an exception', () => {
  const ws = makeWorkspace({ state: 'missing' });
  try {
    const result = runAudit({ ...ws });
    assert.equal(result.ok, false);
    const verbose = renderAudit(result, { verbose: true });
    const stateFail = verbose.find((l) => l.startsWith('[STATE]') && l.includes('unreadable'));
    assert.ok(stateFail, 'expected a [STATE] unreadable line');
    assert.ok(stateFail.endsWith('✗'), 'failure line should carry the fail glyph');
  } finally { cleanup(ws); }
});

// 4) Malformed config.json is reported as a CONFIG failure.
test('malformed config is reported as a CONFIG failure', () => {
  const ws = makeWorkspace({ config: 'malformed' });
  try {
    const result = runAudit({ ...ws });
    assert.equal(result.ok, false);
    const verbose = renderAudit(result, { verbose: true });
    assert.ok(verbose.some((l) => l.startsWith('[CONFIG]') && l.includes('unreadable')), 'expected a [CONFIG] unreadable line');
  } finally { cleanup(ws); }
});

// 5) Happy path: valid state + config → ok=true and no fail glyphs in the verbose body.
test('valid workspace audits clean (no fail-status checks)', () => {
  const ws = makeWorkspace();
  try {
    const result = runAudit({ ...ws });
    // GIT may warn (temp dir is not a repo) but nothing should hard-fail.
    const fails = result.checks.filter((c) => c.status === 'fail');
    assert.equal(fails.length, 0, `unexpected failing checks: ${JSON.stringify(fails)}`);
    assert.equal(result.ok, true);
  } finally { cleanup(ws); }
});

// 6) A temp (non-git) directory is reported gracefully under [GIT] without throwing.
test('non-git directory yields a graceful [GIT] warning', () => {
  const ws = makeWorkspace();
  try {
    const result = runAudit({ ...ws });
    const gitLines = result.checks.filter((c) => c.category === 'GIT');
    assert.ok(gitLines.length >= 1, 'expected at least one GIT check');
    assert.ok(gitLines.some((c) => /not a git repository/.test(c.message)), 'expected a not-a-git-repo notice');
  } finally { cleanup(ws); }
});

// 7) formatLine produces the exact "[CATEGORY] message <glyph>" contract.
test('formatLine renders the category/message/glyph contract', () => {
  assert.equal(formatLine('CONFIG', 'config.json is valid JSON', 'pass'), '[CONFIG] config.json is valid JSON ✓');
  assert.equal(formatLine('STATE', 'tasks array missing', 'fail'), '[STATE] tasks array missing ✗');
  assert.throws(() => formatLine('NOPE', 'x'), /unknown category/);
});

// 8) formatVerbose/formatSummary operate purely on a checks array.
test('formatters work on a synthetic checks array', () => {
  const checks = [
    { category: 'FILES', message: 'state.json present', status: 'pass', detail: 'file' },
    { category: 'CONFIG', message: 'config.json is valid JSON', status: 'pass' },
    { category: 'CONFIG', message: 'config.budgets absent', status: 'warn' }
  ];
  const verbose = formatVerbose(checks);
  assert.equal(verbose.length, 3);
  assert.ok(verbose[0].includes('(file)'), 'detail should be appended in parentheses');
  const summary = formatSummary(checks);
  // CONFIG roll-up shows 2/2 (warn is not a fail) and there is an overall line
  assert.ok(summary.some((l) => l.startsWith('[CONFIG]') && l.includes('2/2')));
});
