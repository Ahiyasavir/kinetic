// quota-discovery.mjs — assertions for the P4 usage-limit discovery + Safe Mode (lib/budget-governor.mjs).
// Verifies: detectQuotaMode classifies known/estimated/unknown; governCycle reports quotaMode; Safe Mode
// is OPT-IN (off → identical legacy behavior); when ON it (a) holds a standing DOWNGRADE on an unknown
// quota but NEVER stops (no deadlock), and (b) TIGHTENS the reserve/downgrade/stop fractions on an
// estimated quota. Crucially, Safe Mode only ever makes the governor MORE conservative — never weaker.
//   node autopilot/tests/quota-discovery.mjs
import assert from 'node:assert/strict';
import { detectQuotaMode, governCycle } from '../lib/budget-governor.mjs';

let passed = 0;
const check = (name, fn) => { fn(); passed++; console.log(`  ✓ ${name}`); };

const st = (inT, outT, cycles) => ({ usage: { inputTokens: inT, outputTokens: outT, cycles } });

// ── detectQuotaMode ──
check('detectQuotaMode: explicit quota → known', () => {
  assert.equal(detectQuotaMode({ budgetGovernor: { weeklyTokenQuota: 1_000_000 } }, 'p'), 'known');
});
check('detectQuotaMode: only a per-project cap → estimated', () => {
  assert.equal(detectQuotaMode({ budgets: { p: { maxTokensPerCycle: 5_000_000 } } }, 'p'), 'estimated');
});
check('detectQuotaMode: neither → unknown', () => {
  assert.equal(detectQuotaMode({}, 'p'), 'unknown');
});

// ── governCycle reports the mode ──
check('governCycle surfaces quotaMode in its result', () => {
  assert.equal(governCycle(st(0, 0, 0), { budgetGovernor: { weeklyTokenQuota: 1_000_000 } }, 'p').quotaMode, 'known');
  assert.equal(governCycle(st(0, 0, 0), {}, 'p').quotaMode, 'unknown');
});

// ── Safe Mode is opt-in (backward compatible) ──
check('unknown quota + safeMode OFF → proceed (legacy behavior unchanged)', () => {
  const g = governCycle(st(9e9, 9e9, 10), { budgetGovernor: { enabled: true } }, 'p');
  assert.equal(g.action, 'proceed');
  assert.equal(g.quotaMode, 'unknown');
  assert.equal(g.safeMode, false);
});

// ── Safe Mode ON, unknown quota → downgrade posture, never stop ──
check('unknown quota + safeMode ON → DOWNGRADE (cheaper models), never STOP', () => {
  const g = governCycle(st(9e9, 9e9, 10), { budgetGovernor: { enabled: true, safeMode: true } }, 'p');
  assert.equal(g.action, 'downgrade');
  assert.match(g.reason, /SAFE MODE/);
  assert.equal(g.safeMode, true);
});

// ── Safe Mode ON, estimated quota → tighter fractions than the defaults ──
check('estimated quota + safeMode ON tightens guards (stops earlier than default would)', () => {
  // Per-project cap = 1,000,000. Default usable = 900k (reserve 10%); Safe reserve 25% → usable 750k.
  // Spend 760k: under default reserve it would NOT hard-trip on reserve, but Safe Mode's higher reserve
  // makes 760k already exceed usable(750k) → STOP. This proves Safe Mode is strictly more conservative.
  const cfg = { budgets: { p: { maxTokensPerCycle: 1_000_000 } },
    budgetGovernor: { enabled: true, safeMode: true, safetyMargin: 0, retryBuffer: 1.0, minCycleTokens: 1 } };
  const cfgUnsafe = { ...cfg, budgetGovernor: { ...cfg.budgetGovernor, safeMode: false } };
  const safe = governCycle(st(380_000, 380_000, 8), cfg, 'p');      // spent 760k
  const unsafe = governCycle(st(380_000, 380_000, 8), cfgUnsafe, 'p');
  assert.equal(safe.quotaMode, 'estimated');
  assert.equal(safe.action, 'stop', 'safe mode stops once spend exceeds the higher-reserve usable');
  assert.notEqual(unsafe.action, 'stop', 'without safe mode the same spend is still within usable');
  assert.match(safe.reason, /SAFE MODE/);
});

// ── known quota is never tightened by safe mode (operator set a deliberate ceiling) ──
check('known quota + safeMode ON behaves like the configured ceiling (no extra tightening)', () => {
  const cfg = { budgetGovernor: { enabled: true, safeMode: true, weeklyTokenQuota: 1_000_000,
    reserveFraction: 0.10, safetyMargin: 0, retryBuffer: 1.0, downgradeFraction: 0.80, hardStopFraction: 0.95, minCycleTokens: 1 } };
  const g = governCycle(st(50_000, 50_000, 1), cfg, 'p'); // spent 100k, well within
  assert.equal(g.quotaMode, 'known');
  assert.equal(g.action, 'proceed');
  assert.equal(g.usable, 900_000, 'known reserve is the configured 10%, not the safe 25%');
});

console.log(`\nquota-discovery: ${passed}/${passed} checks passed ✓`);
