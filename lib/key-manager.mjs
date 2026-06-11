// key-manager.mjs — Stage 1: Autonomous API Key Pooling & Load Balancing (Key Rotation).
//
// WHY: the engine runs unattended against a SHARED, paid account. A single key hitting a 429
// (rate limit) or burning through its daily budget used to stall the whole loop. This module owns
// the runtime state of a POOL of keys (config.api_pools) and hands the fetch layer the next
// available key, so a single account being rate-limited just rotates to the next one instead of
// stopping the engine. Only when EVERY matching-provider key is down does the failure surface to
// the supervisor (as a RateLimitError → existing circuit-breaker / cooldown path).
//
// DESIGN NOTES (keeping the established lib/ conventions):
//   • Secrets are NEVER stored in config.json. Each pool entry names an env var (`key_env`); the
//     actual token is resolved at runtime from process.env (injected via `resolveEnv` for tests).
//   • The KeyManager mutates its OWN cloned records, never the config object passed in.
//   • Time + timers are injectable (`now`, `setTimeoutFn`) so the cooldown/restore logic is
//     deterministic under unit test — same pattern as circuit-breaker.mjs staying Date-free.
//   • Selection is round-robin per provider (load-balancing), skipping any key that is not active,
//     still cooling down, over budget, or missing its env token.

import { RateLimitError } from './claude.mjs';

const ONE_MINUTE_MS = 60 * 1000;

// Thrown when no usable key remains for a provider. Extends RateLimitError so the supervisor's
// existing `err instanceof RateLimitError` handler treats it as a rate-limit cooldown (records the
// streak for the circuit breaker, pauses for `retryAfterMs`) rather than a crash — i.e. the ONLY
// time key exhaustion propagates as a fatal-ish event is when the WHOLE pool is down.
export class AllKeysExhaustedError extends RateLimitError {
  constructor(message, retryAfterMs, provider, { cause } = {}) {
    super(message, retryAfterMs);
    this.name = 'AllKeysExhaustedError';
    this.provider = provider;
    if (cause !== undefined) this.cause = cause;
  }
}

// Normalize one raw config pool entry into a runtime record. Unknown/missing fields get safe
// defaults so a partial config can't crash the manager. Returns null for an unusable entry.
function toRecord(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const id = String(raw.id || '').trim();
  const provider = String(raw.provider || '').trim();
  const key_env = String(raw.key_env || '').trim();
  if (!id || !provider || !key_env) return null;
  const status = ['active', 'exhausted', 'rate-limited'].includes(raw.status) ? raw.status : 'active';
  const daily_budget = Number(raw.daily_budget) > 0 ? Number(raw.daily_budget) : 0; // 0 = uncapped
  return {
    id,
    provider,
    key_env,
    status,
    daily_budget,
    current_usage: Number(raw.current_usage) || 0,
    tokensUsed: Number(raw.tokensUsed) || 0,
    // retry_after is a JS Date (or null) per the schema; accept an ISO string from a restored config.
    retry_after: raw.retry_after ? new Date(raw.retry_after) : null,
    _timer: null,
  };
}

export class KeyManager {
  /**
   * @param {Array<object>} pools  config.api_pools (raw entries; cloned + normalized here)
   * @param {object} [opts]
   * @param {() => number} [opts.now]         injectable clock (ms) — defaults to Date.now
   * @param {Function} [opts.setTimeoutFn]    injectable timer — defaults to global setTimeout
   * @param {(name:string)=>(string|undefined)} [opts.resolveEnv]  env lookup — defaults to process.env
   * @param {Function} [opts.logger]          one-line logger — defaults to console.log
   */
  constructor(pools = [], opts = {}) {
    this.now = opts.now || (() => Date.now());
    this.setTimeoutFn = opts.setTimeoutFn || setTimeout;
    this.resolveEnv = opts.resolveEnv || ((name) => process.env[name]);
    this.logger = opts.logger || (() => {});
    this.records = (Array.isArray(pools) ? pools : []).map(toRecord).filter(Boolean);
    this._cursors = new Map(); // provider → round-robin index
  }

  _byId(keyId) {
    return this.records.find((r) => r.id === keyId) || null;
  }

  _token(rec) {
    const v = this.resolveEnv(rec.key_env);
    return v ? String(v) : null;
  }

  // Lazily restore a key whose cooldown has elapsed (covers the case where the scheduled timer
  // didn't fire — e.g. process restart with a persisted retry_after).
  _maybeRestore(rec) {
    if (rec.status === 'rate-limited' && rec.retry_after && rec.retry_after.getTime() <= this.now()) {
      rec.status = 'active';
      rec.retry_after = null;
      this._clearTimer(rec);
    }
  }

  _isAvailable(rec) {
    this._maybeRestore(rec);
    if (rec.status !== 'active') return false;
    if (rec.retry_after && rec.retry_after.getTime() > this.now()) return false;
    if (rec.daily_budget > 0 && rec.current_usage >= rec.daily_budget) return false;
    if (!this._token(rec)) return false; // env var unset → unusable, skip silently
    return true;
  }

  _clearTimer(rec) {
    if (rec._timer) {
      try { clearTimeout(rec._timer); } catch { /* ignore */ }
      rec._timer = null;
    }
  }

  /**
   * Round-robin selection of the next available key for `provider`. Returns a descriptor
   * { id, provider, token, status, daily_budget, current_usage, retry_after } or null when no key
   * is currently usable (caller treats null as "whole pool down for this provider").
   */
  getNextKey(provider) {
    const pool = this.records.filter((r) => r.provider === provider);
    if (pool.length === 0) return null;
    const start = this._cursors.get(provider) || 0;
    for (let i = 0; i < pool.length; i++) {
      const idx = (start + i) % pool.length;
      const rec = pool[idx];
      if (this._isAvailable(rec)) {
        this._cursors.set(provider, (idx + 1) % pool.length); // advance for true round-robin
        return {
          id: rec.id,
          provider: rec.provider,
          token: this._token(rec),
          status: rec.status,
          daily_budget: rec.daily_budget,
          current_usage: rec.current_usage,
          retry_after: rec.retry_after,
        };
      }
    }
    return null;
  }

  /**
   * Mark a key as temporarily unusable after a 429 / rate-limit. Sets status to 'rate-limited' (or
   * 'exhausted' when no cooldown is given), stamps retry_after, and schedules an automatic restore
   * to 'active' when the cooldown elapses. Idempotent per key (re-marking resets the timer).
   */
  markExhausted(keyId, cooldownMs = ONE_MINUTE_MS) {
    const rec = this._byId(keyId);
    if (!rec) return null;
    this._clearTimer(rec);
    const ms = Number(cooldownMs) > 0 ? Number(cooldownMs) : 0;
    if (ms > 0) {
      rec.status = 'rate-limited';
      rec.retry_after = new Date(this.now() + ms);
      const timer = this.setTimeoutFn(() => this.restore(keyId), ms);
      if (timer && typeof timer.unref === 'function') timer.unref(); // don't keep the process alive
      rec._timer = timer;
    } else {
      // No cooldown window → treat as hard-exhausted (manual/automatic restore required).
      rec.status = 'exhausted';
      rec.retry_after = null;
    }
    return rec.status;
  }

  /**
   * Increment a key's spend/usage and enforce its daily budget. When current_usage crosses
   * daily_budget the key flips to 'exhausted' and is scheduled to restore (with usage reset) at the
   * next UTC midnight. Returns { breached, current_usage }.
   */
  trackUsage(keyId, tokensUsed = 0, cost = 0) {
    const rec = this._byId(keyId);
    if (!rec) return { breached: false, current_usage: 0 };
    rec.tokensUsed += Number(tokensUsed) || 0;
    rec.current_usage += Number(cost) || 0;
    let breached = false;
    if (rec.daily_budget > 0 && rec.current_usage >= rec.daily_budget) {
      breached = true;
      rec.status = 'exhausted';
      const resetAt = nextUtcMidnight(this.now());
      rec.retry_after = new Date(resetAt);
      this._clearTimer(rec);
      const ms = Math.max(0, resetAt - this.now());
      const timer = this.setTimeoutFn(() => {
        rec.current_usage = 0; // daily budget rolls over
        this.restore(keyId);
      }, ms);
      if (timer && typeof timer.unref === 'function') timer.unref();
      rec._timer = timer;
      this.logger(`[KeyManager] Key ${rec.id} exhausted daily budget ($${rec.current_usage.toFixed(2)}/$${rec.daily_budget}). Resting until ${rec.retry_after.toISOString()}.`);
    }
    return { breached, current_usage: rec.current_usage };
  }

  /** Manually return a key to active (clears any pending restore timer + retry_after). */
  restore(keyId) {
    const rec = this._byId(keyId);
    if (!rec) return null;
    this._clearTimer(rec);
    rec.status = 'active';
    rec.retry_after = null;
    return rec;
  }

  /** Count of currently-usable keys for a provider. */
  availableCount(provider) {
    return this.records.filter((r) => r.provider === provider && this._isAvailable(r)).length;
  }

  /** Total configured keys for a provider (regardless of status). */
  poolSize(provider) {
    return this.records.filter((r) => r.provider === provider).length;
  }

  /** True when a provider has at least one configured key but none are currently usable. */
  allDown(provider) {
    return this.poolSize(provider) > 0 && this.availableCount(provider) === 0;
  }

  /**
   * Milliseconds until the soonest-recovering key of a provider becomes usable again (for sizing a
   * cooldown when the whole pool is down). Returns null if nothing is on a timed cooldown.
   */
  soonestRetryMs(provider) {
    const waits = this.records
      .filter((r) => r.provider === provider && r.retry_after)
      .map((r) => r.retry_after.getTime() - this.now())
      .filter((ms) => ms > 0);
    return waits.length ? Math.min(...waits) : null;
  }

  /** Secret-free snapshot of the pool state for logging / telemetry. */
  snapshot() {
    return this.records.map((r) => ({
      id: r.id,
      provider: r.provider,
      key_env: r.key_env,
      status: r.status,
      hasToken: !!this._token(r),
      daily_budget: r.daily_budget,
      current_usage: Number(r.current_usage.toFixed(4)),
      tokensUsed: r.tokensUsed,
      retry_after: r.retry_after ? r.retry_after.toISOString() : null,
    }));
  }

  /** Clear every pending restore timer (call on shutdown so timers can't outlive the process). */
  dispose() {
    for (const rec of this.records) this._clearTimer(rec);
  }
}

// Next UTC midnight as epoch ms — when a daily budget rolls over.
function nextUtcMidnight(nowMs) {
  const d = new Date(nowMs);
  return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate() + 1, 0, 0, 0, 0);
}

/**
 * Build a drop-in replacement for an adapter's `run()` that transparently rotates keys on 429s.
 *
 * On each call it pulls the next available key for the resolved pool-provider, injects it
 * (`apiKey`/`keyId`) into the adapter call, and:
 *   • success → tracks usage (tokens + cost) against that key, returns the result;
 *   • rate-limit (adapter.isRateLimit) → markExhausted(key, retry-after | default), logs the
 *     rotation line, and retries the SAME call on the next key (up to maxRetries rotations);
 *   • non-rate-limit error → propagates unchanged (a real bug must not be masked as a rotation);
 *   • no key available / retries exhausted → throws AllKeysExhaustedError (a RateLimitError), so the
 *     supervisor's existing cooldown + circuit-breaker path handles "the whole pool is down".
 *
 * @returns {(opts:object)=>Promise<object>} a run() with the adapter's exact signature/result shape.
 */
export function makeRotatingRun({ adapter, keyManager, config = {}, logger = console.log }) {
  const kr = config.keyRotation || {};
  const maxRetries = Number.isInteger(kr.maxRetries) ? kr.maxRetries : 3;
  const defaultCooldownMs = Number(kr.defaultCooldownMs) > 0 ? Number(kr.defaultCooldownMs) : ONE_MINUTE_MS;
  // config.provider is the ADAPTER id ('claude'); the pool entries use the upstream PROVIDER name
  // ('anthropic'). Map between them (overridable via config.keyRotation.providerMap).
  const providerMap = kr.providerMap || { claude: 'anthropic' };
  const poolProvider = providerMap[config.provider] || config.provider || 'anthropic';

  return async function rotatingRun(opts) {
    let lastErr = null;
    for (let attempt = 0; attempt <= maxRetries; attempt++) {
      const key = keyManager.getNextKey(poolProvider);
      if (!key) break; // whole pool down — fall through to AllKeysExhaustedError below
      try {
        const res = await adapter.run({ ...opts, apiKey: key.token, keyId: key.id });
        keyManager.trackUsage(key.id, adapter.tokensOf(res), adapter.priceOf(res, config));
        return res;
      } catch (err) {
        if (adapter.isRateLimit(err)) {
          const cooldownMs = adapter.retryAfterMs(err) ?? defaultCooldownMs;
          keyManager.markExhausted(key.id, cooldownMs);
          logger(`[KeyManager] Key ${key.id} rate-limited. Rotating keys and retrying cycle...`);
          lastErr = err;
          continue;
        }
        throw err; // genuine error (bad request, spawn failure, …) — do not mask as rotation
      }
    }
    const waitMs = keyManager.soonestRetryMs(poolProvider) ?? defaultCooldownMs;
    throw new AllKeysExhaustedError(
      `[KeyManager] All "${poolProvider}" keys are exhausted or rate-limited — backing off ${Math.round(waitMs / 1000)}s.`,
      waitMs,
      poolProvider,
      { cause: lastErr }
    );
  };
}

/** Convenience: construct a KeyManager from the loader's normalized apiPools + a logger. */
export function createKeyManager(apiPools, opts = {}) {
  return new KeyManager(apiPools, opts);
}
