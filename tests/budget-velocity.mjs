// budget-velocity.mjs — assertions for the adaptive-cadence velocity factor.
//   node autopilot/tests/budget-velocity.mjs
import assert from 'node:assert/strict';
import { computeVelocityFactor, effectivePerDay, computeAdaptiveCyclesPerDay } from '../lib/learn.mjs';

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

// ---------- token-aware adaptive cadence (smart maxCyclesPerDay) ----------

// 6) DEPLETING — few tokens left over many days ⇒ tight cadence (the bug case: cycle pacing said OK
//    while tokens were nearly gone). 54M usable, 5.4d, 2M/cycle ⇒ floor(54/2 × 0.9 / 5.4) = 4/day.
check('adaptive: 54M left / 5.4d / 2M-per-cycle ⇒ ~4/day, far below the 200 ceiling', () => {
  const perDay = computeAdaptiveCyclesPerDay({
    remainingUsableTokens: 54_000_000, daysToReset: 5.4, avgTokensPerCycle: 2_000_000,
    floorPerDay: 4, ceilPerDay: 200, safetyFactor: 0.9,
  });
  assert.ok(perDay <= 5 && perDay >= 4, `perDay=${perDay}`);
});

// 7) FRESH window — full quota, full week ⇒ relaxes back up (but still token-bounded, not the ceiling).
check('adaptive: fresh 180M / 7d / 2M-per-cycle ⇒ ~11/day', () => {
  const perDay = computeAdaptiveCyclesPerDay({
    remainingUsableTokens: 180_000_000, daysToReset: 7, avgTokensPerCycle: 2_000_000,
    floorPerDay: 4, ceilPerDay: 200, safetyFactor: 0.9,
  });
  assert.ok(perDay >= 10 && perDay <= 12, `perDay=${perDay}`);
});

// 8) NO QUOTA — undiscoverable budget ⇒ falls back to the ceiling (legacy, no extra throttle).
check('adaptive: Infinity remaining ⇒ ceiling (backward compatible)', () => {
  assert.equal(computeAdaptiveCyclesPerDay({ remainingUsableTokens: Infinity, daysToReset: 7, avgTokensPerCycle: 1e6, ceilPerDay: 200 }), 200);
  assert.equal(computeAdaptiveCyclesPerDay({ remainingUsableTokens: NaN, daysToReset: 7, avgTokensPerCycle: 1e6, ceilPerDay: 150 }), 150);
});

// 9) EXHAUSTED — zero/negative budget ⇒ the minimum cadence (never fully stalls).
check('adaptive: <=0 remaining ⇒ floorPerDay', () => {
  assert.equal(computeAdaptiveCyclesPerDay({ remainingUsableTokens: 0, daysToReset: 3, avgTokensPerCycle: 1e6, floorPerDay: 4, ceilPerDay: 200 }), 4);
  assert.equal(computeAdaptiveCyclesPerDay({ remainingUsableTokens: -5, daysToReset: 3, avgTokensPerCycle: 1e6, floorPerDay: 2, ceilPerDay: 200 }), 2);
});

// 10) NEAR-RESET — tiny daysToReset must not spike the allowance (floored at 1h); ceiling still caps it.
check('adaptive: near-reset (0.001d) is floored at 1h and capped by the ceiling', () => {
  const perDay = computeAdaptiveCyclesPerDay({
    remainingUsableTokens: 100_000_000, daysToReset: 0.001, avgTokensPerCycle: 1_000_000,
    floorPerDay: 4, ceilPerDay: 50, safetyFactor: 1.0,
  });
  assert.equal(perDay, 50, `perDay=${perDay} (should clamp to ceiling, not spike)`);
});

// 11) CLAMP — result is always within [floorPerDay, ceilPerDay].
check('adaptive: result clamps to [floor, ceil]', () => {
  const hi = computeAdaptiveCyclesPerDay({ remainingUsableTokens: 1e12, daysToReset: 0.5, avgTokensPerCycle: 1, floorPerDay: 4, ceilPerDay: 30 });
  assert.equal(hi, 30);
  const lo = computeAdaptiveCyclesPerDay({ remainingUsableTokens: 1, daysToReset: 7, avgTokensPerCycle: 1e9, floorPerDay: 6, ceilPerDay: 200 });
  assert.equal(lo, 6);
});

console.log(`\nbudget-velocity: ${passed} assertion group(s) passed.`);
