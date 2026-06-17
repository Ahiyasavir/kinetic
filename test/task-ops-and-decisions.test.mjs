// Tests for the UI task-management ops (lib/task-ops.mjs) and the decision-log parser
// (lib/decision-log.mjs).
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { applyTaskOp, applyTaskOps } from '../lib/task-ops.mjs';
import { parseDecisionLog, selectEntries, summarizeEntry } from '../lib/decision-log.mjs';

function freshState() {
  return { queues: {
    backlog: [{ id: 'A' }, { id: 'B' }, { id: 'C' }],
    blocked: [{ id: 'X', blockReason: 'boom', attempts: 3, cooldownUntilCycle: 99 }],
    done: [{ id: 'D' }],
  } };
}

describe('task-ops: delete', () => {
  it('removes a task from the backlog', () => {
    const s = freshState();
    assert.equal(applyTaskOp(s, { op: 'delete', taskId: 'B' }), true);
    assert.deepEqual(s.queues.backlog.map(t => t.id), ['A', 'C']);
  });
  it('removes a task from blocked and done too', () => {
    const s = freshState();
    applyTaskOp(s, { op: 'delete', taskId: 'X' });
    applyTaskOp(s, { op: 'delete', taskId: 'D' });
    assert.equal(s.queues.blocked.length, 0);
    assert.equal(s.queues.done.length, 0);
  });
  it('deleting an absent task is a harmless no-op (idempotent)', () => {
    const s = freshState();
    assert.equal(applyTaskOp(s, { op: 'delete', taskId: 'ZZZ' }), false);
    assert.equal(s.queues.backlog.length, 3);
  });
});

describe('task-ops: retry (blocked → front of backlog)', () => {
  it('moves the blocked task to the front and resets failure bookkeeping', () => {
    const s = freshState();
    assert.equal(applyTaskOp(s, { op: 'retry', taskId: 'X' }), true);
    assert.equal(s.queues.backlog[0].id, 'X');
    assert.equal(s.queues.blocked.length, 0);
    const x = s.queues.backlog[0];
    assert.equal(x.blockReason, undefined);
    assert.equal(x.cooldownUntilCycle, undefined);
    assert.equal(x.attempts, 0);
    assert.equal(x.needsReReview, true);
  });
  it('retrying a non-blocked id is a no-op', () => {
    const s = freshState();
    assert.equal(applyTaskOp(s, { op: 'retry', taskId: 'A' }), false);
  });
});

describe('task-ops: bump (move to front of backlog)', () => {
  it('moves a mid/back task to the front', () => {
    const s = freshState();
    assert.equal(applyTaskOp(s, { op: 'bump', taskId: 'C' }), true);
    assert.deepEqual(s.queues.backlog.map(t => t.id), ['C', 'A', 'B']);
  });
  it('bumping the already-front task is a no-op', () => {
    const s = freshState();
    assert.equal(applyTaskOp(s, { op: 'bump', taskId: 'A' }), false);
  });
  it('bumping an absent task is a no-op', () => {
    const s = freshState();
    assert.equal(applyTaskOp(s, { op: 'bump', taskId: 'ZZ' }), false);
  });
});

describe('task-ops: applyTaskOps batch + idempotency', () => {
  it('applies a batch and counts changes', () => {
    const s = freshState();
    const n = applyTaskOps(s, [
      { op: 'bump', taskId: 'C' },
      { op: 'delete', taskId: 'B' },
      { op: 'delete', taskId: 'B' }, // second delete is a no-op
    ]);
    assert.equal(n, 2);
    assert.deepEqual(s.queues.backlog.map(t => t.id), ['C', 'A']);
  });
  it('unknown op is ignored', () => {
    const s = freshState();
    assert.equal(applyTaskOp(s, { op: 'frobnicate', taskId: 'A' }), false);
  });
});

const SAMPLE_LOG = `# Decision Log

## Cycle 1 — 2026-06-02T21:02:03.318Z
- **Task:** H-REG — registerTeam resilience: clear bilingual errors
- **Goal phase:** access
- **Why chosen:** Registration is the first thing every team does.
- **Implementer model:** opus (claude-opus-4-8)
- **Outcome:** merged
- **WHAT IS NOW LIVE:** Typed bilingual error toasts.
- **Notes:** No backend behavior changed.

## Cycle 9 — 2026-06-03T04:16:25.255Z
- **Task:** U-1 — Hebrew localization audit
- **Goal phase:** ui
- **Why chosen:** The user explicitly asked to verify Hebrew localization.
- **Outcome:** blocked
- **Notes:** Larger follow-up deferred.
`;

describe('decision-log: parseDecisionLog', () => {
  it('splits into one entry per cycle', () => {
    const e = parseDecisionLog(SAMPLE_LOG);
    assert.equal(e.length, 2);
    assert.equal(e[0].cycle, 1);
    assert.equal(e[1].cycle, 9);
  });
  it('extracts the cycle timestamp', () => {
    const e = parseDecisionLog(SAMPLE_LOG);
    assert.equal(e[0].ts, '2026-06-02T21:02:03.318Z');
  });
  it('splits task id from title on the em-dash', () => {
    const e = parseDecisionLog(SAMPLE_LOG);
    assert.equal(e[0].task, 'H-REG');
    assert.match(e[0].title, /registerTeam resilience/);
  });
  it('captures bold-label fields as camelCase keys', () => {
    const e = parseDecisionLog(SAMPLE_LOG);
    assert.equal(e[0].fields.goalPhase, 'access');
    assert.equal(e[0].fields.whyChosen, 'Registration is the first thing every team does.');
    assert.equal(e[0].fields.whatIsNowLive, 'Typed bilingual error toasts.');
    assert.equal(e[0].outcome, 'merged');
  });
  it('keeps the raw block for full rendering', () => {
    const e = parseDecisionLog(SAMPLE_LOG);
    assert.match(e[0].raw, /## Cycle 1/);
    assert.match(e[0].raw, /Notes/);
  });
});

describe('decision-log: selectEntries', () => {
  it('returns newest-first summaries limited to n', () => {
    const sel = selectEntries(SAMPLE_LOG, { n: 1 });
    assert.equal(sel.count, 2);
    assert.equal(sel.summaries.length, 1);
    assert.equal(sel.summaries[0].cycle, 9); // newest
    assert.equal(sel.full, null);
  });
  it('returns the full entry for a requested cycle', () => {
    const sel = selectEntries(SAMPLE_LOG, { n: 10, cycle: 1 });
    assert.ok(sel.full);
    assert.equal(sel.full.cycle, 1);
    assert.equal(sel.full.outcome, 'merged');
    assert.match(sel.full.raw, /H-REG/);
  });
  it('summarizeEntry exposes the row fields', () => {
    const e = parseDecisionLog(SAMPLE_LOG)[0];
    const s = summarizeEntry(e);
    assert.equal(s.cycle, 1);
    assert.equal(s.task, 'H-REG');
    assert.equal(s.outcome, 'merged');
    assert.match(s.model, /opus/);
  });
});
