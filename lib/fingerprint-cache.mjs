// fingerprint-cache.mjs — cache DECISIONS (not implementation output) keyed by a deterministic
// fingerprint of their inputs. The selector's job — "given this backlog/done/blocked state, which task
// next?" — is a pure function of that state, so when the fingerprint is unchanged the prior decision is
// still correct and we can skip a (cheap but recurring) selector LLM call.
//
// WHAT IS CACHED: classification / selection / routing / summary style decisions — anything whose
// inputs we can fingerprint and whose output is a small reusable verdict.
// WHAT IS NEVER CACHED: implementation output (code). Implementation depends on the live working tree
// and must always run fresh; this module is only imported for decision lookups.
//
// Storage lives in state.fpCache: { entries: { [fp]: {value, at, hits} }, order: [fp...] (LRU, newest
// last), stats: { hits, misses, tokensSaved, costSavedUsd } }. Bounded LRU (default 20 entries).
import { createHash } from 'node:crypto';

const DEFAULT_MAX = 20;

// Stable JSON: sort object keys recursively so logically-equal inputs hash identically.
function stableStringify(v) {
  if (v === null || typeof v !== 'object') return JSON.stringify(v);
  if (Array.isArray(v)) return '[' + v.map(stableStringify).join(',') + ']';
  const keys = Object.keys(v).sort();
  return '{' + keys.map((k) => JSON.stringify(k) + ':' + stableStringify(v[k])).join(',') + '}';
}

// Deterministic short hash of any structured input.
export function fingerprint(parts) {
  return createHash('sha256').update(stableStringify(parts)).digest('hex').slice(0, 32);
}

// Fingerprint the selector's decision inputs: the *identity set* of each queue (ids+titles) plus the
// goal phase. Order-independent (sorted) so a re-ordered-but-same backlog reuses the decision; any
// add/remove/retitle/phase-change changes the fingerprint and forces a fresh selection.
//
// `candidates` (optional) is the EXACT set the selector will be offered this cycle — pass the host's
// post-filter selectable pool (e.g. cooldown-excluded) rather than the raw backlog so the cache key
// tracks what the selector actually sees. This is what prevents a cache hit from replaying a pick that
// is no longer eligible (e.g. a just-failed task now on an anti-churn cooldown): dropping it from the
// pool changes the fingerprint → cache miss → fresh selection. Defaults to state.queues.backlog.
export function selectorFingerprint(state, candidates) {
  const ids = (q) => (q || []).map((t) => `${t.id}:${t.title || ''}`).sort();
  return fingerprint({
    kind: 'selector',
    backlog: ids(candidates || state?.queues?.backlog),
    done: ids(state?.queues?.done),
    blocked: ids(state?.queues?.blocked),
    phase: state?.goalPhase || ''
  });
}

function ensureCache(state) {
  if (!state.fpCache || typeof state.fpCache !== 'object') {
    state.fpCache = { entries: {}, order: [], stats: { hits: 0, misses: 0, tokensSaved: 0, costSavedUsd: 0 } };
  }
  if (!state.fpCache.entries) state.fpCache.entries = {};
  if (!Array.isArray(state.fpCache.order)) state.fpCache.order = [];
  if (!state.fpCache.stats) state.fpCache.stats = { hits: 0, misses: 0, tokensSaved: 0, costSavedUsd: 0 };
  return state.fpCache;
}

// Look up a cached decision. Records a hit/miss in stats and (on hit) credits the estimated savings.
// @param {{tokens?:number, costUsd?:number}} [saved]  what re-running would have cost (credited on hit)
export function getCachedDecision(state, fp, saved = {}) {
  const c = ensureCache(state);
  const e = c.entries[fp];
  if (!e) { c.stats.misses += 1; return null; }
  e.hits = (e.hits || 0) + 1;
  c.stats.hits += 1;
  c.stats.tokensSaved += Number(saved.tokens) || 0;
  c.stats.costSavedUsd += Number(saved.costUsd) || 0;
  // LRU bump: move this fp to the most-recent end.
  c.order = c.order.filter((k) => k !== fp);
  c.order.push(fp);
  return e.value;
}

// Store a decision under its fingerprint with LRU eviction (default 20 entries).
export function putCachedDecision(state, fp, value, { max = DEFAULT_MAX, at = null } = {}) {
  const c = ensureCache(state);
  if (!c.entries[fp]) c.order.push(fp);
  c.entries[fp] = { value, at, hits: c.entries[fp]?.hits || 0 };
  while (c.order.length > max) {
    const evict = c.order.shift();
    if (evict !== fp) delete c.entries[evict];
  }
  return c;
}

// Cache hit-rate over its lifetime (0..1); 0 when never queried.
export function cacheHitRate(state) {
  const s = state?.fpCache?.stats;
  if (!s) return 0;
  const total = (s.hits || 0) + (s.misses || 0);
  return total > 0 ? s.hits / total : 0;
}
