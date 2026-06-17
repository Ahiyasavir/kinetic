// Tests for the rate-limit understanding fixes:
//   1. usage-ledger.mjs — self-tracked rolling 5h / 7d windows (replaces the broken statusline path)
//   2. claude.mjs parseRetryMs — clock-time reset parsing ("resets at 3pm") + injectable clock
//   3. usage-provider getBestUsage — 5h view now populated from the ledger (was hardcoded null)

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import {
  recordSpend, windowSpend, fiveHourSpend, sevenDaySpend, fiveHourView,
  FIVE_HOUR_MS, SEVEN_DAY_MS,
} from '../lib/usage-ledger.mjs';
import { parseRetryMs } from '../lib/claude.mjs';
import { getBestUsage } from '../lib/usage-provider.mjs';

const MIN = 60 * 1000;
const HOUR = 60 * MIN;

describe('usage-ledger: rolling windows', () => {
  it('records spend with a timestamp and sums within a window', () => {
    const now = 1_000_000_000_000;
    const state = {};
    recordSpend(state, 100, now - 2 * HOUR);
    recordSpend(state, 50, now - 30 * MIN);
    recordSpend(state, 25, now);
    assert.equal(fiveHourSpend(state, now), 175, 'all three are within 5h');
  });

  it('excludes spend older than the 5h window but keeps it in 7d', () => {
    const now = 2_000_000_000_000;
    const state = {};
    recordSpend(state, 1000, now - 6 * HOUR); // outside 5h, inside 7d
    recordSpend(state, 40, now - 1 * HOUR);   // inside 5h
    assert.equal(fiveHourSpend(state, now), 40, '6h-old entry excluded from 5h');
    assert.equal(sevenDaySpend(state, now), 1040, 'both counted in 7d');
  });

  it('prunes entries older than 7 days on append', () => {
    const now = 3_000_000_000_000;
    const state = {};
    recordSpend(state, 999, now - (SEVEN_DAY_MS + HOUR)); // should be pruned
    recordSpend(state, 10, now);
    assert.equal(state.usage.ledger.length, 1, 'stale entry pruned');
    assert.equal(sevenDaySpend(state, now), 10);
  });

  it('ignores zero/negative token observations', () => {
    const now = 4_000_000_000_000;
    const state = {};
    recordSpend(state, 0, now);
    recordSpend(state, -5, now);
    recordSpend(state, 7, now);
    assert.equal(state.usage.ledger.length, 1);
    assert.equal(fiveHourSpend(state, now), 7);
  });

  it('windowSpend on an empty/missing ledger is 0 (never throws)', () => {
    assert.equal(windowSpend({}, FIVE_HOUR_MS, Date.now()), 0);
    assert.equal(windowSpend({ usage: {} }, FIVE_HOUR_MS, Date.now()), 0);
  });

  it('fiveHourView reports spent, entries, and a sane rolling resetAt', () => {
    const now = 5_000_000_000_000;
    const state = {};
    recordSpend(state, 300, now - 4 * HOUR); // oldest in-window → drives resetAt
    recordSpend(state, 200, now - 1 * HOUR);
    const v = fiveHourView(state, 1000, now);
    assert.equal(v.spentTokens, 500);
    assert.equal(v.entries, 2);
    assert.equal(v.usedPercent, 50, '500/1000 = 50%');
    // oldest entry (4h ago) ages out of the 5h window 1h from now
    assert.equal(v.resetAt, now - 4 * HOUR + FIVE_HOUR_MS);
    assert.equal(v.resetAt - now, HOUR);
  });

  it('fiveHourView on empty ledger: zero pressure, resetAt = now', () => {
    const now = 6_000_000_000_000;
    const v = fiveHourView({}, 1000, now);
    assert.equal(v.spentTokens, 0);
    assert.equal(v.entries, 0);
    assert.equal(v.resetAt, now);
  });
});

describe('parseRetryMs: clock-time reset formats (what Anthropic actually sends)', () => {
  // Anchor "now" at a fixed wall-clock instant so local-time math is deterministic relative to it.
  const base = new Date(2026, 5, 14, 14, 0, 0, 0).getTime(); // 14 Jun 2026, 2:00pm local

  it('parses "resets at 3pm" → ~1h', () => {
    const ms = parseRetryMs('Claude usage limit reached. Your limit will reset at 3pm.', base);
    assert.equal(ms, 1 * HOUR);
  });

  it('parses "resets 3:45pm" → 1h45m', () => {
    const ms = parseRetryMs('5-hour limit reached ∙ resets 3:45pm', base);
    assert.equal(ms, 1 * HOUR + 45 * MIN);
  });

  it('rolls to tomorrow when the clock time already passed today', () => {
    const ms = parseRetryMs('resets at 1pm', base); // 1pm < 2pm now → next day
    assert.equal(ms, 23 * HOUR);
  });

  it('handles the 12pm (noon) boundary correctly', () => {
    // now is 2pm; noon already passed today → next day's noon = 22h away
    assert.equal(parseRetryMs('resets at 12pm', base), 22 * HOUR);
  });

  it('handles the 12am (midnight) boundary correctly', () => {
    // now is 2pm; next midnight is 10h away
    assert.equal(parseRetryMs('resets at 12am', base), 10 * HOUR);
  });

  it('still parses explicit epoch reset (highest priority)', () => {
    const future = Math.floor((base + 5 * MIN) / 1000); // 10-digit epoch seconds
    const ms = parseRetryMs(`resets at ${future}`, base);
    assert.ok(Math.abs(ms - 5 * MIN) < 1000, 'epoch reset honored');
  });

  it('still parses retry-after seconds', () => {
    assert.equal(parseRetryMs('retry-after: 120', base), 120 * 1000);
  });

  it('still parses "in N minutes"', () => {
    assert.equal(parseRetryMs('try again in 17 minutes', base), 17 * MIN);
  });

  it('returns null for an unparseable message', () => {
    assert.equal(parseRetryMs('something went wrong', base), null);
  });
});

describe('getBestUsage: 5h window populated from the ledger when statusline is absent', () => {
  it('fiveHour is null with no ledger and no snapshot (no false data)', () => {
    const u = getBestUsage({ usage: {} }, {}, null);
    assert.equal(u.fiveHour, null);
    assert.equal(u.fiveHourSource, 'none');
  });

  it('fiveHour comes from the ledger when entries exist', () => {
    const now = 7_000_000_000_000;
    const state = { usage: {} };
    recordSpend(state, 500, now - 1 * HOUR);
    const u = getBestUsage(state, {}, null);
    assert.ok(u.fiveHour, 'fiveHour populated');
    assert.equal(u.fiveHourSource, 'ledger');
    assert.ok(u.fiveHour.spentTokens >= 500);
  });
});
