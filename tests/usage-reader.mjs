// usage-reader.mjs — assertions for lib/usage-reader.mjs (TRUE account-wide usage from transcripts).
// Verifies: extractEntry pulls cache-inclusive tokens from the real JSONL shape; measureUsage sums the
// weekly + 5h windows, dedupes by message:request id, scopes to a fixed weekly start, and degrades to
// zeros when the transcript dir is absent. Uses a temp fixture dir (no dependency on ~/.claude).
//   node autopilot/tests/usage-reader.mjs
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { extractEntry, measureUsage, _resetCache } from '../lib/usage-reader.mjs';

let passed = 0;
const check = (name, fn) => { fn(); passed++; console.log(`  ✓ ${name}`); };

const NOW = Date.parse('2026-06-17T12:00:00Z');
const ISO = (msAgo) => new Date(NOW - msAgo).toISOString();

// A realistic assistant transcript line (mirrors ~/.claude/projects/**/*.jsonl).
const line = (o) => JSON.stringify({
  type: 'assistant',
  timestamp: o.ts,
  requestId: o.rid,
  message: { id: o.mid, model: o.model || 'claude-sonnet-4-6',
    usage: { input_tokens: o.in || 0, output_tokens: o.out || 0,
      cache_creation_input_tokens: o.cc || 0, cache_read_input_tokens: o.cr || 0 } },
});

// ── extractEntry ──
check('extractEntry sums cache-inclusive tokens', () => {
  const e = extractEntry(JSON.parse(line({ ts: ISO(0), rid: 'r1', mid: 'm1', in: 10, out: 20, cc: 100, cr: 1000 })));
  assert.equal(e.tokens, 1130);
  assert.equal(e.hash, 'm1:r1');
});
check('extractEntry returns null for a usage-less line', () => {
  assert.equal(extractEntry({ type: 'user', timestamp: ISO(0), message: { role: 'user' } }), null);
});

// ── measureUsage over a fixture dir ──
const dir = mkdtempSync(path.join(tmpdir(), 'ccusage-'));
try {
  const HOUR = 3600000, DAY = 86400000;
  writeFileSync(path.join(dir, 'a.jsonl'), [
    line({ ts: ISO(1 * HOUR), rid: 'r1', mid: 'm1', in: 0, out: 0, cc: 0, cr: 1_000_000 }), // in 5h + week
    line({ ts: ISO(7 * HOUR), rid: 'r2', mid: 'm2', out: 2_000_000 }),                       // week only (>5h ago)
    line({ ts: ISO(10 * DAY), rid: 'r3', mid: 'm3', out: 9_000_000 }),                       // outside week
  ].join('\n') + '\n', 'utf8');
  // Duplicate of m1:r1 in a second file — must be deduped, not double-counted.
  writeFileSync(path.join(dir, 'b.jsonl'),
    line({ ts: ISO(1 * HOUR), rid: 'r1', mid: 'm1', cr: 1_000_000 }) + '\n', 'utf8');

  const weeklyStartMs = NOW - 7 * DAY;

  check('measureUsage: 5h window sums only the last 5 hours', () => {
    _resetCache();
    const m = measureUsage({ nowMs: NOW, weeklyStartMs, projectsDir: dir });
    assert.equal(m.fiveHour.tokens, 1_000_000);
    assert.equal(m.fiveHour.entries, 1);
  });
  check('measureUsage: weekly window sums in-window, excludes older', () => {
    _resetCache();
    const m = measureUsage({ nowMs: NOW, weeklyStartMs, projectsDir: dir });
    assert.equal(m.weekly.tokens, 3_000_000); // m1 (1M) + m2 (2M); m3 excluded
    assert.equal(m.weekly.entries, 2);
  });
  check('measureUsage: dedupes the same message:request across files', () => {
    _resetCache();
    const m = measureUsage({ nowMs: NOW, weeklyStartMs, projectsDir: dir });
    assert.equal(m.weekly.tokens, 3_000_000); // m1 counted once despite appearing in a.jsonl and b.jsonl
  });
  check('measureUsage: missing dir degrades to zeros (available:false)', () => {
    _resetCache();
    const m = measureUsage({ nowMs: NOW, weeklyStartMs, projectsDir: path.join(dir, 'does-not-exist') });
    assert.equal(m.available, false);
    assert.equal(m.weekly.tokens, 0);
  });
} finally {
  rmSync(dir, { recursive: true, force: true });
}

console.log(`\nusage-reader: ${passed}/${passed} checks passed ✓`);
