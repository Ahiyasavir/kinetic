// telemetry.mjs — decoupled engine telemetry (U-36).
//
// A self-contained logging framework that reports the KINETIC ENGINE's own health and execution
// metrics (cycle duration, token count, error count, an event log) INDEPENDENTLY of the RushPoint
// product it happens to be driving. The supervisor + watchdog emit events through this module; nothing
// here knows anything about RushPoint, Firestore, or any target app — so the same telemetry travels
// unchanged to any project the engine runs against.
//
// Backend is configurable (config.json → telemetry): events/metrics are buffered locally in a small
// in-memory ring and, when an `endpoint` is set, batched out to an external monitoring URL on flush.
// When `enabled` is false EVERY recording call is a cheap no-op, so callers (supervisor/watchdog) never
// branch on a flag — disabling telemetry is a pure config edit, no engine-logic change.
//
// The live buffer is surfaced via getTelemetryState() so the supervisor can persist it into state.json
// under the FRAMEWORK tier (state.telemetry → on-disk `.framework.telemetry`), kept fully separate from
// the target-app state tier.

const DEFAULTS = { enabled: false, endpoint: null, batchSize: 50, flushIntervalMs: 60000 };

// Cap the persisted event log so a long multi-day run can never bloat state.json. We keep the most
// recent MAX_EVENTS events in the buffer (older ones drop off the front after they've been flushed).
const MAX_EVENTS = 200;

let _config = { ...DEFAULTS };
let _state = freshState();

function freshState() {
  return {
    events: [],          // [{ ts, type, data }] — most recent kept (capped at MAX_EVENTS)
    metrics: {},          // name -> { last, count, sum, min, max } rollup
    errorCount: 0,        // running count of recorded 'error'-type events
    cycleCount: 0,        // running count of cycle-end events seen
    lastCycleMs: null,    // duration of the most recent completed cycle
    lastTokenCount: null, // token count reported with the most recent cycle-end
    startedAt: null,      // when init was last called
    lastFlush: null       // ISO timestamp of the last successful flush
  };
}

/**
 * (Re)initialize the telemetry backend from a resolved config block. Resets the in-memory buffer so a
 * fresh process starts clean. Safe to call with no args (keeps defaults → disabled).
 * @param {object} [cfg] { enabled, endpoint?, batchSize?, flushIntervalMs? }
 */
export function initTelemetry(cfg = {}) {
  _config = { ...DEFAULTS, ...(cfg || {}) };
  _state = freshState();
  _state.startedAt = new Date().toISOString();
  return getTelemetryState();
}

/** True when telemetry is currently enabled (callers don't need to branch — recorders no-op anyway). */
export function isTelemetryEnabled() {
  return !!_config.enabled;
}

/**
 * Record a single named numeric metric (e.g. recordMetric('cycle.durationMs', 1234)). Maintains a small
 * rollup (last/count/sum/min/max) under that name. No-op when telemetry is disabled.
 */
export function recordMetric(name, value) {
  if (!_config.enabled || !name) return;
  const v = Number(value);
  if (!Number.isFinite(v)) return;
  const m = _state.metrics[name] || { last: null, count: 0, sum: 0, min: null, max: null };
  m.last = v;
  m.count += 1;
  m.sum += v;
  m.min = m.min === null ? v : Math.min(m.min, v);
  m.max = m.max === null ? v : Math.max(m.max, v);
  _state.metrics[name] = m;
}

/**
 * Record a discrete engine event (e.g. recordEvent('cycle-start', { cycle: 12 })). Events are appended
 * to a capped ring buffer; 'error'-type events also bump errorCount, and 'cycle-end' events fold their
 * { durationMs, tokens } into the engine rollup. No-op when telemetry is disabled.
 */
export function recordEvent(eventType, data = {}) {
  if (!_config.enabled || !eventType) return;
  const ts = new Date().toISOString();
  _state.events.push({ ts, type: eventType, data: data || {} });
  if (_state.events.length > MAX_EVENTS) _state.events.splice(0, _state.events.length - MAX_EVENTS);

  if (eventType === 'error') _state.errorCount += 1;
  if (eventType === 'cycle-end') {
    _state.cycleCount += 1;
    if (data && typeof data.durationMs === 'number') {
      _state.lastCycleMs = data.durationMs;
      recordMetric('cycle.durationMs', data.durationMs);
    }
    if (data && typeof data.tokens === 'number') {
      _state.lastTokenCount = data.tokens;
      recordMetric('cycle.tokens', data.tokens);
    }
  }
}

/**
 * Flush buffered telemetry. When an `endpoint` is configured the current batch (capped at batchSize) is
 * POSTed to the external monitoring URL; otherwise telemetry simply stays buffered locally (and is
 * persisted by the caller into state.json). Always stamps lastFlush. Never throws — a failed network
 * send is swallowed so telemetry can never take the engine down. No-op when disabled.
 * @returns {Promise<{ sent: boolean, count: number, error?: string }>}
 */
export async function flushTelemetry() {
  if (!_config.enabled) return { sent: false, count: 0 };
  const batch = _state.events.slice(-Math.max(1, _config.batchSize || DEFAULTS.batchSize));
  let result = { sent: false, count: batch.length };
  if (_config.endpoint && batch.length && typeof fetch === 'function') {
    try {
      await fetch(_config.endpoint, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ source: 'kinetic-engine', flushedAt: new Date().toISOString(),
          metrics: _state.metrics, events: batch })
      });
      result.sent = true;
    } catch (e) {
      result.error = e && e.message ? e.message : String(e);
    }
  }
  _state.lastFlush = new Date().toISOString();
  return result;
}

/**
 * A serializable snapshot of the current telemetry buffer. The supervisor assigns this onto
 * `state.telemetry` so it persists under state.json's framework tier ('.framework.telemetry'), separate
 * from the target-app state.
 */
export function getTelemetryState() {
  return {
    events: _state.events.slice(),
    metrics: { ..._state.metrics },
    errorCount: _state.errorCount,
    cycleCount: _state.cycleCount,
    lastCycleMs: _state.lastCycleMs,
    lastTokenCount: _state.lastTokenCount,
    startedAt: _state.startedAt,
    lastFlush: _state.lastFlush
  };
}
