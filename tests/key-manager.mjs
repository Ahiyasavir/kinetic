// key-manager.mjs — assertions for Stage 1 API key pooling / load balancing.
//   • KeyManager — round-robin selection, rate-limit cooldown + auto-restore, daily-budget exhaustion
//   • makeRotatingRun — transparent 429 rotation + retry, AllKeysExhaustedError only when pool is dry
//   node autopilot/tests/key-manager.mjs
import assert from 'node:assert/strict';
import { KeyManager, makeRotatingRun, AllKeysExhaustedError, createKeyManager } from '../lib/key-manager.mjs';
import { RateLimitError } from '../lib/claude.mjs';

let passed = 0;
const check = (name, fn) => { fn(); passed++; console.log(`  ✓ ${name}`); };
const checkAsync = async (name, fn) => { await fn(); passed++; console.log(`  ✓ ${name}`); };

// A controllable clock + timer so cooldown logic is deterministic (no real waiting).
function harness() {
  let nowMs = 1_000_000;
  const timers = []; // { fireAt, cb }
  const now = () => nowMs;
  const setTimeoutFn = (cb, ms) => { const t = { fireAt: nowMs + ms, cb, unref() {} }; timers.push(t); return t; };
  const advance = (ms) => {
    nowMs += ms;
    for (const t of [...timers]) {
      if (t.fireAt <= nowMs) { timers.splice(timers.indexOf(t), 1); t.cb(); }
    }
  };
  return { now, setTimeoutFn, advance };
}

const POOLS = [
  { id: 'a1', provider: 'anthropic', key_env: 'K1', daily_budget: 10 },
  { id: 'a2', provider: 'anthropic', key_env: 'K2', daily_budget: 10 },
  { id: 'o1', provider: 'openrouter', key_env: 'KO' },
];
const ENV = { K1: 'tok-1', K2: 'tok-2', KO: 'tok-o' };
const resolveEnv = (name) => ENV[name];

// ── KeyManager: round-robin selection ───────────────────────────────────────
check('getNextKey round-robins across active keys of a provider', () => {
  const km = new KeyManager(POOLS, { resolveEnv, ...harness() });
  assert.equal(km.getNextKey('anthropic').id, 'a1');
  assert.equal(km.getNextKey('anthropic').id, 'a2');
  assert.equal(km.getNextKey('anthropic').id, 'a1'); // wraps
  assert.equal(km.getNextKey('openrouter').id, 'o1');
});

check('getNextKey injects the resolved env token, never the env var name', () => {
  const km = new KeyManager(POOLS, { resolveEnv, ...harness() });
  assert.equal(km.getNextKey('anthropic').token, 'tok-1');
});

check('a key whose env var is unset is skipped (not selectable)', () => {
  const km = new KeyManager(POOLS, { resolveEnv: (n) => (n === 'K1' ? undefined : ENV[n]), ...harness() });
  // a1 has no token → first available is a2
  assert.equal(km.getNextKey('anthropic').id, 'a2');
});

check('unknown provider with no pool returns null', () => {
  const km = new KeyManager(POOLS, { resolveEnv, ...harness() });
  assert.equal(km.getNextKey('openai'), null);
});

// ── markExhausted: cooldown + auto-restore ───────────────────────────────────
check('markExhausted sets rate-limited + retry_after and removes the key from rotation', () => {
  const h = harness();
  const km = new KeyManager(POOLS, { resolveEnv, ...h });
  km.markExhausted('a1', 60_000);
  assert.equal(km.snapshot().find((k) => k.id === 'a1').status, 'rate-limited');
  // a1 is skipped → only a2 served repeatedly
  assert.equal(km.getNextKey('anthropic').id, 'a2');
  assert.equal(km.getNextKey('anthropic').id, 'a2');
});

check('scheduled timer auto-restores a rate-limited key to active', () => {
  const h = harness();
  const km = new KeyManager(POOLS, { resolveEnv, ...h });
  km.markExhausted('a1', 60_000);
  h.advance(60_001);
  assert.equal(km.snapshot().find((k) => k.id === 'a1').status, 'active');
  assert.equal(km.availableCount('anthropic'), 2);
});

check('lazy restore: a key past its cooldown is usable even if the timer never fired', () => {
  const h = harness();
  const km = new KeyManager(POOLS, { resolveEnv, now: h.now, setTimeoutFn: () => ({ unref() {} }) });
  km.markExhausted('a1', 60_000);
  h.advance(60_001); // timer is a no-op stub; rely on lazy _maybeRestore
  assert.equal(km.availableCount('anthropic'), 2);
});

// ── trackUsage: daily budget exhaustion ──────────────────────────────────────
check('trackUsage flips status to exhausted when daily_budget is breached', () => {
  const h = harness();
  const km = new KeyManager(POOLS, { resolveEnv, ...h });
  let r = km.trackUsage('a1', 1000, 6);
  assert.equal(r.breached, false);
  r = km.trackUsage('a1', 1000, 5); // 11 ≥ 10
  assert.equal(r.breached, true);
  assert.equal(km.snapshot().find((k) => k.id === 'a1').status, 'exhausted');
  assert.equal(km.getNextKey('anthropic').id, 'a2'); // exhausted key skipped
});

check('uncapped key (daily_budget 0) never breaches', () => {
  const h = harness();
  const km = new KeyManager(POOLS, { resolveEnv, ...h });
  const r = km.trackUsage('o1', 999999, 9999);
  assert.equal(r.breached, false);
  assert.equal(km.getNextKey('openrouter').id, 'o1');
});

check('allDown / availableCount reflect the live pool', () => {
  const h = harness();
  const km = new KeyManager(POOLS, { resolveEnv, ...h });
  km.markExhausted('a1', 60_000);
  km.markExhausted('a2', 120_000);
  assert.equal(km.allDown('anthropic'), true);
  assert.equal(km.availableCount('anthropic'), 0);
  assert.ok(km.soonestRetryMs('anthropic') <= 60_000);
});

// ── makeRotatingRun: transparent 429 rotation ────────────────────────────────
function rlAdapter(failIds, { retryAfterMs = null } = {}) {
  // adapter.run fails (rate limit) for keys in failIds, succeeds otherwise.
  return {
    id: 'claude',
    run: async ({ keyId }) => {
      if (failIds.has(keyId)) { const e = new RateLimitError(`429 for ${keyId}`, retryAfterMs); throw e; }
      return { ok: true, keyId, usage: { input_tokens: 100, output_tokens: 50 }, costUsd: 0.01 };
    },
    tokensOf: (res) => (res.usage.input_tokens + res.usage.output_tokens),
    priceOf: (res) => res.costUsd,
    isRateLimit: (err) => err instanceof RateLimitError,
    retryAfterMs: (err) => (typeof err?.retryAfterMs === 'number' ? err.retryAfterMs : null),
  };
}

await checkAsync('rotatingRun rotates past a rate-limited key and succeeds transparently', async () => {
  const h = harness();
  const km = new KeyManager(POOLS, { resolveEnv, ...h });
  const adapter = rlAdapter(new Set(['a1']));
  const run = makeRotatingRun({ adapter, keyManager: km, config: { provider: 'claude', keyRotation: { maxRetries: 3, defaultCooldownMs: 60000 } }, logger: () => {} });
  const res = await run({ prompt: 'hi' });
  assert.equal(res.ok, true);
  assert.equal(res.keyId, 'a2'); // a1 429'd, rotated to a2
  assert.equal(km.snapshot().find((k) => k.id === 'a1').status, 'rate-limited');
});

await checkAsync('rotatingRun tracks usage against the succeeding key', async () => {
  const h = harness();
  const km = new KeyManager(POOLS, { resolveEnv, ...h });
  const adapter = rlAdapter(new Set());
  const run = makeRotatingRun({ adapter, keyManager: km, config: { provider: 'claude', keyRotation: {} }, logger: () => {} });
  await run({ prompt: 'hi' }); // hits a1
  const a1 = km.snapshot().find((k) => k.id === 'a1');
  assert.equal(a1.tokensUsed, 150);
  assert.ok(Math.abs(a1.current_usage - 0.01) < 1e-9);
});

await checkAsync('rotatingRun uses the 429 retry-after hint for the cooldown', async () => {
  const h = harness();
  const km = new KeyManager(POOLS, { resolveEnv, ...h });
  const adapter = rlAdapter(new Set(['a1']), { retryAfterMs: 5000 });
  const run = makeRotatingRun({ adapter, keyManager: km, config: { provider: 'claude', keyRotation: {} }, logger: () => {} });
  await run({ prompt: 'hi' });
  const a1 = km.snapshot().find((k) => k.id === 'a1');
  assert.ok(new Date(a1.retry_after).getTime() - h.now() <= 5000);
});

await checkAsync('rotatingRun throws AllKeysExhaustedError (a RateLimitError) only when the WHOLE pool is down', async () => {
  const h = harness();
  const km = new KeyManager(POOLS, { resolveEnv, ...h });
  const adapter = rlAdapter(new Set(['a1', 'a2'])); // both anthropic keys 429
  const run = makeRotatingRun({ adapter, keyManager: km, config: { provider: 'claude', keyRotation: { maxRetries: 3 } }, logger: () => {} });
  await assert.rejects(run({ prompt: 'hi' }), (err) => {
    assert.ok(err instanceof AllKeysExhaustedError);
    assert.ok(err instanceof RateLimitError); // supervisor's existing handler catches this
    assert.equal(err.provider, 'anthropic');
    assert.ok(err.retryAfterMs > 0); // a real cooldown to pause for
    return true;
  });
});

await checkAsync('rotatingRun propagates a NON-rate-limit error unchanged (never masked as rotation)', async () => {
  const h = harness();
  const km = new KeyManager(POOLS, { resolveEnv, ...h });
  const adapter = {
    id: 'claude',
    run: async () => { throw new Error('boom: real bug'); },
    tokensOf: () => 0, priceOf: () => 0,
    isRateLimit: () => false, retryAfterMs: () => null,
  };
  const run = makeRotatingRun({ adapter, keyManager: km, config: { provider: 'claude', keyRotation: {} }, logger: () => {} });
  await assert.rejects(run({ prompt: 'hi' }), /boom: real bug/);
});

check('createKeyManager factory builds an equivalent manager', () => {
  const km = createKeyManager(POOLS, { resolveEnv, ...harness() });
  assert.equal(km.poolSize('anthropic'), 2);
});

console.log(`\nkey-manager: ${passed} checks passed.`);
