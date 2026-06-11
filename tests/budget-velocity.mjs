// budget-velocity.mjs — assertions for the adaptive-cadence velocity factor.
//   node autopilot/tests/budget-velocity.mjs
import assert from 'node:assert/strict';
import { computeVelocityFactor, effectivePerDay } from '../lib/learn.mjs';

const DAY = 86400000;
const cfg = { resetIntervalDays: 7, maxCyclesPerDay: 30, velocitySensitivity: 1.0 };
// 7d * 30/day = 210 cycle budget; window starts at t0.
const t0 = Date.UTC(2026, 0, 1);
const halfWindow = t0 + 3.5 * DAY; // 50% of the week elapsed

let passed = 0;
const check = (name, fn) => { fn(); passed++; console.log(`  ✓ ${name}`); };

// 1) STABLE — consuming exactly in step with the clock ⇒ factor ≈ 1.0, full rate.
check('stable: 50% budget at 50% week ⇒ vf ≈ 1.0, full rate', () => {
  const vf = computeVelocityFactor({ ...cfg, cycles: 105, windowStartedMs: t0, now: halfWindow });
  assert.ok(Math.abs(vf - 1.0) < 0.01, `vf=${vf}`);
  assert.equal(effectivePerDay(cfg.maxCyclesPerDay, vf), 30);
});

// 2) OVER-BUDGET — 80% of budget at 50% week ⇒ vf 1.6, rate throttled down.
check('over-budget: 80% budget at 50% week ⇒ vf 1.6, rate drops', () => {
  const vf = computeVelocityFactor({ ...cfg, cycles: 168, windowStartedMs: t0, now: halfWindow });
  assert.ok(Math.abs(vf - 1.6) < 0.01, `vf=${vf}`);
  const rate = effectivePerDay(cfg.maxCyclesPerDay, vf);
  assert.ok(rate < 30 && rate === Math.floor(30 / vf), `rate=${rate}`);
});

// 3) UNDER-BUDGET — 20% of budget at 50% week ⇒ vf 0.4, full configured rate.
check('under-budget: 20% budget at 50% week ⇒ vf 0.4, full rate', () => {
  const vf = computeVelocityFactor({ ...cfg, cycles: 42, windowStartedMs: t0, now: halfWindow });
  assert.ok(Math.abs(vf - 0.4) < 0.01, `vf=${vf}`);
  assert.equal(effectivePerDay(cfg.maxCyclesPerDay, vf), 30);
});

// 4) WINDOW-ROLLOVER edge — window just started (≈0 elapsed) with cycles already spent must NOT
//    divide-by-zero; it clamps to the 2.0 ceiling. Floor-at-4 also holds for a small base rate.
check('window-rollover: ~0 elapsed clamps to 2.0 ceiling (no div-by-zero)', () => {
  const vf = computeVelocityFactor({ ...cfg, cycles: 5, windowStartedMs: t0, now: t0 });
  assert.equal(vf, 2.0, `vf=${vf}`);
  assert.equal(effectivePerDay(5, vf), 4); // floor(5/2)=2 → floored to the 4/day minimum
  assert.equal(effectivePerDay(30, vf), 15);
});

// 5) clamp floor — absurd over-consumption never drops below 0.1, never exceeds 2.0.
check('clamps to [0.1, 2.0]', () => {
  assert.equal(computeVelocityFactor({ ...cfg, cycles: 9999, windowStartedMs: t0, now: halfWindow }), 2.0);
  assert.equal(computeVelocityFactor({ ...cfg, cycles: 0, windowStartedMs: t0, now: halfWindow }), 0.1);
});

console.log(`\nbudget-velocity: ${passed} assertion group(s) passed.`);
