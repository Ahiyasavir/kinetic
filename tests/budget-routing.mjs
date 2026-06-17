// budget-routing.mjs — assertions for the safety/cost/provider-adaptability change set:
//   • budget-governor.mjs — deterministic proceed/downgrade/stop formula + reserve + retry buffer
//   • route.mjs           — class+risk+budget routing, deterministic downgrade
//   • verify.mjs          — non-LLM gauntlet ("PASS typecheck" never sufficient)
//   • providers/          — adapter interface, registry, tier resolution
//   node autopilot/tests/budget-routing.mjs
import assert from 'node:assert/strict';
import { governCycle, estimateNextCycleTokens, resolveQuota, governorConfig, TIER_QUOTAS } from '../lib/budget-governor.mjs';
import { pickImplementerModel, baseTier } from '../lib/route.mjs';
import { nonLlmVerify } from '../lib/verify.mjs';
import { getAdapter, listProviders, registerAdapter, tokensOfResult } from '../lib/providers/index.mjs';

let passed = 0;
const check = (name, fn) => { fn(); passed++; console.log(`  ✓ ${name}`); };

// quota: 1,000,000 tokens; reserve 10% → usable 900k; downgrade at 80% of usable = 720k.
const CFG = { provider: 'claude', models: { implementerHigh: 'claude-opus-4-8', implementerLow: 'claude-sonnet-4-6', implementerLowest: 'claude-haiku-4-5' },
  implementerRouting: { opusMinRisk: 3, opusKeywords: ['scoring', 'security'] },
  budgetGovernor: { enabled: true, weeklyTokenQuota: 1_000_000, reserveFraction: 0.10, safetyMargin: 0, retryBuffer: 1.0, downgradeFraction: 0.80, hardStopFraction: 0.95, minCycleTokens: 50_000 } };
const st = (inT, outT, cycles) => ({ usage: { inputTokens: inT, outputTokens: outT, cycles } });

// ── budget governor ───────────────────────────────────────────────────────
check('PROCEED when well within budget', () => {
  const g = governCycle(st(50_000, 50_000, 1), CFG, 'p'); // spent 100k, est ~100k, proj 200k ≤ 720k
  assert.equal(g.action, 'proceed');
});
check('DOWNGRADE when projected crosses 80% of usable', () => {
  const g = governCycle(st(330_000, 330_000, 6), CFG, 'p'); // spent 660k, avg 110k, proj 770k > 720k, < 900k
  assert.equal(g.action, 'downgrade');
});
check('STOP when next cycle would breach usable budget', () => {
  const g = governCycle(st(440_000, 440_000, 8), CFG, 'p'); // spent 880k, proj > 900k usable
  assert.equal(g.action, 'stop');
});
check('STOP at the hard quota guard (95%)', () => {
  const g = governCycle(st(480_000, 480_000, 100), CFG, 'p'); // spent 960k ≥ 950k hardStop
  assert.equal(g.action, 'stop');
  assert.match(g.reason, /hard quota guard/);
});
check('estimate is CONSERVATIVE: padded by safetyMargin × retryBuffer', () => {
  const cfg = { budgetGovernor: { minCycleTokens: 10_000, safetyMargin: 0.2, retryBuffer: 1.5 } };
  const e = estimateNextCycleTokens(st(100_000, 0, 1), cfg); // avg 100k × 1.2 × 1.5 = 180k
  assert.equal(Math.round(e), 180_000);
});
check('reserve is withheld (usable = quota × (1 − reserveFraction))', () => {
  const g = governCycle(st(0, 0, 0), CFG, 'p');
  assert.equal(g.usable, 900_000);
});
check('no quota configured → always PROCEED (backward compatible)', () => {
  const g = governCycle(st(9e9, 9e9, 10), { budgetGovernor: { enabled: true } }, 'p');
  assert.equal(g.action, 'proceed');
  assert.equal(resolveQuota({}, 'p'), Infinity);
});
check('quota falls back to per-project cap when no explicit quota', () => {
  assert.equal(resolveQuota({ budgets: { p: { maxTokensPerCycle: 5_000_000 } } }, 'p'), 5_000_000);
});
check('calibratedQuota from state overrides per-project cap', () => {
  const stateWithCalibrated = { usage: { calibratedQuota: 56_000_000 } };
  assert.equal(resolveQuota({ budgets: { p: { maxTokensPerCycle: 5_000_000 } } }, 'p', null, 0, stateWithCalibrated), 56_000_000);
});
check('calibratedQuota from state takes priority over config weeklyTokenQuota', () => {
  const stateWithCalibrated = { usage: { calibratedQuota: 56_000_000 } };
  const cfgWithQuota = { budgetGovernor: { weeklyTokenQuota: 100_000_000 } };
  // Priority chain: live > calibrated > config, so calibrated wins
  assert.equal(resolveQuota(cfgWithQuota, 'p', null, 0, stateWithCalibrated), 56_000_000);
});
check('resolveQuota with no calibrated state falls through to config', () => {
  const stateWithout = { usage: {} };
  const cfgWithQuota = { budgetGovernor: { weeklyTokenQuota: 100_000_000 } };
  assert.equal(resolveQuota(cfgWithQuota, 'p', null, 0, stateWithout), 100_000_000);
});
check('TIER_QUOTAS maps contain expected tiers', () => {
  assert.equal(TIER_QUOTAS.free, 25_000_000);
  assert.equal(TIER_QUOTAS.pro, 56_000_000);
  assert.equal(TIER_QUOTAS.max, 200_000_000);
});
check('governCycle with calibratedQuota in state produces correct fractionUsed', () => {
  const proState = { usage: { inputTokens: 24_000_000, outputTokens: 24_000_000, cycles: 10, calibratedQuota: 56_000_000 } };
  const cfgNoQuota = { budgetGovernor: { enabled: true, reserveFraction: 0.10, safetyMargin: 0, retryBuffer: 1.0, downgradeFraction: 0.80, hardStopFraction: 0.95, minCycleTokens: 50_000 } };
  const g = governCycle(proState, cfgNoQuota, 'p');
  // spent = 48M, quota = 56M → fractionUsed ≈ 0.857
  assert.ok(Math.abs(g.fractionUsed - (48_000_000 / 56_000_000)) < 0.01, `fractionUsed should be ~0.857, got ${g.fractionUsed}`);
  assert.equal(g.quota, 56_000_000);
  // At 86% of a 56M quota with 10% reserve, usable = 50.4M, spent = 48M → should stop or downgrade
  assert.ok(g.action === 'stop' || g.action === 'downgrade', `expected stop/downgrade at 86%, got ${g.action}`);
});
check('governCycle surfaces calibratedQuota into its output (for the budget block)', () => {
  const st = { usage: { inputTokens: 1_000_000, outputTokens: 0, cycles: 1, calibratedQuota: 56_000_000 } };
  const cfg = { budgetGovernor: { enabled: true } };
  const g = governCycle(st, cfg, 'p');
  assert.equal(g.calibratedQuota, 56_000_000);
});
check('resolveQuota honors state.budget.calibratedQuota as a fallback when usage lacks it', () => {
  const stateBudgetOnly = { usage: {}, budget: { calibratedQuota: 56_000_000 } };
  const cfgWithQuota = { budgetGovernor: { weeklyTokenQuota: 100_000_000 } };
  // usage has no calibrated value → fall through to the budget block before the config ceiling
  assert.equal(resolveQuota(cfgWithQuota, 'p', null, 0, stateBudgetOnly), 56_000_000);
});
check('state.usage.calibratedQuota takes priority over state.budget.calibratedQuota', () => {
  const both = { usage: { calibratedQuota: 56_000_000 }, budget: { calibratedQuota: 25_000_000 } };
  assert.equal(resolveQuota({}, 'p', null, 0, both), 56_000_000);
});

// ── routing ────────────────────────────────────────────────────────────────
check('high risk → strong (opus)', () => {
  const r = pickImplementerModel({ title: 'x', goal: 'product', risk: 4 }, CFG);
  assert.equal(r.tier, 'strong'); assert.equal(r.model, 'claude-opus-4-8');
});
check('low-risk maintenance → cheap (haiku)', () => {
  const r = pickImplementerModel({ title: 'chore: tidy', goal: 'chore', risk: 1 }, CFG);
  assert.equal(r.tier, 'cheap'); assert.equal(r.model, 'claude-haiku-4-5');
});
check('architectural keyword → strong even at low risk', () => {
  const r = pickImplementerModel({ title: 'tweak scoring formula', goal: 'product', risk: 1 }, CFG);
  assert.equal(r.tier, 'strong');
});
check('budget DOWNGRADE drops one tier deterministically (strong→mid)', () => {
  const r = pickImplementerModel({ title: 'x', goal: 'product', risk: 4 }, CFG, { budgetAction: 'downgrade' });
  assert.equal(r.tier, 'mid'); assert.equal(r.model, 'claude-sonnet-4-6');
  assert.match(r.reason, /DOWNGRADE/);
});
check('downgrade floors at cheap (cheap stays cheap)', () => {
  const r = pickImplementerModel({ title: 'chore: x', goal: 'chore', risk: 1 }, CFG, { budgetAction: 'downgrade' });
  assert.equal(r.tier, 'cheap');
});
check('baseTier ignores budget; downgrade only via overlay', () => {
  assert.equal(baseTier({ title: 'x', goal: 'product', risk: 5 }, CFG).tier, 'strong');
});

// ── non-LLM verification ─────────────────────────────────────────────────────
check('PASS typecheck alone is NOT sufficient (dead module blocks)', () => {
  const v = nonLlmVerify({ task: { goal: 'architecture', title: 'architecture: x', verifyArtifacts: [{ path: 'autopilot/lib/nope.mjs' }] },
    config: CFG, validation: { ok: true, summary: 'PASS typecheck' }, repoRoot: '.' });
  assert.equal(v.ok, false);
  assert.ok(v.blockingFails.includes('evidence(file+wiring)'));
});
check('green validation + wired evidence → ok, llmNeeded', () => {
  // No repoRoot override — let evidence.mjs use its default REPO_ROOT (derived from import.meta.url)
  // so the artifact path 'autopilot/lib/budget-governor.mjs' resolves correctly regardless of CWD.
  const v = nonLlmVerify({ task: { goal: 'architecture', title: 'architecture: x', verifyArtifacts: [{ path: 'autopilot/lib/budget-governor.mjs', wired: true }] },
    config: CFG, validation: { ok: true, summary: 'PASS' } });
  assert.equal(v.ok, true); assert.equal(v.llmNeeded, true);
});
check('product task with no diff fails the product-diff check', () => {
  const v = nonLlmVerify({ task: { goal: 'product', title: 'product: screen' }, config: CFG,
    validation: { ok: true, summary: 'PASS' }, hasDiff: false, repoRoot: '.' });
  assert.equal(v.ok, false);
  assert.ok(v.blockingFails.includes('product-diff'));
});
check('engine task with empty diff is NOT penalized for the diff', () => {
  const v = nonLlmVerify({ task: { goal: 'architecture', title: 'architecture: x' }, config: CFG,
    validation: { ok: true, summary: 'PASS' }, hasDiff: false, repoRoot: '.' });
  assert.equal(v.ok, true);
});

// ── riskToModel routing (U-56) ───────────────────────────────────────────────
const CFG_RTM = { ...CFG, implementerRouting: { ...CFG.implementerRouting, opusMinRisk: 4,
  riskToModel: { '1': 'claude-haiku-4-5', '2': 'claude-haiku-4-5', '3': 'claude-sonnet-4-6', '4': 'claude-sonnet-4-6', '5': 'claude-opus-4-8' } } };
check('riskToModel: risk 1 → Haiku (cheap tier)', () => {
  const r = pickImplementerModel({ title: 'minor fix', goal: 'ui', risk: 1 }, CFG_RTM);
  assert.equal(r.tier, 'cheap'); assert.equal(r.model, 'claude-haiku-4-5');
  assert.match(r.reason, /riskToModel\[1\]/);
});
check('riskToModel: risk 2 → configurable fallback (Haiku by default)', () => {
  const r = pickImplementerModel({ title: 'minor fix', goal: 'ui', risk: 2 }, CFG_RTM);
  assert.equal(r.tier, 'cheap'); assert.equal(r.model, 'claude-haiku-4-5');
});
check('riskToModel: risk 3 → Sonnet (mid tier)', () => {
  const r = pickImplementerModel({ title: 'feature', goal: 'product', risk: 3 }, CFG_RTM);
  assert.equal(r.tier, 'mid'); assert.equal(r.model, 'claude-sonnet-4-6');
  assert.match(r.reason, /riskToModel\[3\]/);
});
check('riskToModel: safety floor still wins over riskToModel (opusMinRisk=4, risk=5→Opus)', () => {
  // risk 5 → safetyFloor fires → riskToModel is skipped
  const r = pickImplementerModel({ title: 'risky', goal: 'product', risk: 5 }, CFG_RTM);
  assert.equal(r.tier, 'strong'); assert.equal(r.model, 'claude-opus-4-8');
});
check('riskToModel: budget downgrade after riskToModel mapping (mid→cheap)', () => {
  const r = pickImplementerModel({ title: 'feature', goal: 'product', risk: 3 }, CFG_RTM, { budgetAction: 'downgrade' });
  assert.equal(r.tier, 'cheap');
  assert.match(r.reason, /DOWNGRADE/);
});

// ── provider adapters ────────────────────────────────────────────────────────
check('default adapter is claude; resolves logical tiers', () => {
  const a = getAdapter(CFG);
  assert.equal(a.id, 'claude');
  assert.equal(a.resolveModel('strong', CFG), 'claude-opus-4-8');
  assert.equal(a.resolveModel('mid', CFG), 'claude-sonnet-4-6');
  assert.equal(a.resolveModel('cheap', CFG), 'claude-haiku-4-5');
});
check('adapter normalizes tokens + price from a result', () => {
  const a = getAdapter(CFG);
  const res = { usage: { input_tokens: 100, output_tokens: 200 }, costUsd: 0.05 };
  assert.equal(a.tokensOf(res), 300);
  assert.equal(tokensOfResult(res), 300);
  assert.equal(a.priceOf(res, CFG), 0.05); // provider-reported truth preferred
});
check('unknown provider throws (no silent wrong-vendor fallback)', () => {
  assert.throws(() => getAdapter({ provider: 'nope' }), /unknown provider/);
});
check('a new provider can be registered without touching core', () => {
  const fake = { id: 'fake', run: async () => ({ ok: true, usage: {} }), resolveModel: (t) => `fake-${t}`,
    estimateTokens: () => 1, tokensOf: () => 0, priceOf: () => 0, isRateLimit: () => false, retryAfterMs: () => null };
  registerAdapter(fake);
  assert.ok(listProviders().includes('fake'));
  assert.equal(getAdapter({ provider: 'fake' }).resolveModel('strong'), 'fake-strong');
});
check('registerAdapter rejects an incomplete adapter', () => {
  assert.throws(() => registerAdapter({ id: 'broken' }), /missing required member/);
});

console.log(`\nbudget-routing: ${passed}/${passed} checks passed ✓`);
