// autopilot/tests/forecaster.mjs — U-65 backlog cost forecaster unit tests.
// Static evidence marker: forecaster-test-suite-v1

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  calculateBacklogForecast,
  recordGoalRiskCost,
  statsToHistorical,
  bucketKey,
} from '../lib/forecaster.mjs';

test('calculateBacklogForecast with full history — uses per-bucket avgCost', () => {
  const historical = {
    'user.2': { avgCost: 60000, count: 5 },
    'engine.3': { avgCost: 80000, count: 3 },
  };
  const tasks = [
    { goal: 'user', risk: 2 },
    { goal: 'engine', risk: 3 },
    { goal: 'user', risk: 2 },
  ];
  const result = calculateBacklogForecast(tasks, historical);
  assert.equal(result.taskCount, 3, 'taskCount should match the number of input tasks');
  assert.equal(result.fallbackUsed, false, 'should not use fallback when all buckets have history');
  assert.equal(result.missing.length, 0, 'missing array should be empty when all buckets found');
  assert.equal(result.totalCost, 60000 + 80000 + 60000, 'totalCost should sum per-bucket avgCosts');
  assert.ok(Object.keys(result.breakdown).length > 0, 'breakdown should have at least one entry');
});

test('calculateBacklogForecast with missing buckets — uses global fallback', () => {
  const historical = {
    'user.2': { avgCost: 50000, count: 2 },
  };
  const tasks = [
    { goal: 'user', risk: 2 },
    { goal: 'maintenance', risk: 5 },
  ];
  const result = calculateBacklogForecast(tasks, historical);
  assert.equal(result.taskCount, 2, 'taskCount should equal the number of tasks');
  assert.equal(result.fallbackUsed, true, 'fallbackUsed should be true when a bucket is missing');
  const missingKey = bucketKey('maintenance', 5);
  assert.ok(result.missing.includes(missingKey), 'missing should contain the unknown bucket key');
});

test('recordGoalRiskCost window bounding — caps samples at GOAL_RISK_WINDOW (20)', () => {
  const stats = {};
  for (let i = 0; i < 25; i++) {
    recordGoalRiskCost(stats, 'user', 3, i * 1000);
  }
  const key = bucketKey('user', 3);
  const arr = stats.costsByGoalAndRisk[key];
  assert.ok(Array.isArray(arr), 'costsByGoalAndRisk entry should be an array');
  assert.ok(arr.length <= 20, `window should be capped at 20 but got ${arr.length}`);
  // Most-recent samples should be retained (sliding window drops oldest).
  assert.equal(arr[arr.length - 1], 24000, 'last sample should be the most recently added');
});

test('statsToHistorical — converts raw sample arrays to avgCost+count shape', () => {
  const appStats = {
    costsByGoalAndRisk: {
      'user.2': [50000, 60000, 70000],
      'engine.3': [80000],
      'bad.bucket': 'not-an-array',
    },
  };
  const result = statsToHistorical(appStats);
  assert.ok('user.2' in result, 'user.2 bucket should be present');
  assert.ok('engine.3' in result, 'engine.3 bucket should be present');
  assert.ok(!('bad.bucket' in result), 'non-array buckets should be skipped');
  assert.equal(typeof result['user.2'].avgCost, 'number', 'avgCost should be a number');
  assert.equal(result['user.2'].count, 3, 'count should equal the number of samples');
  assert.ok(Math.abs(result['user.2'].avgCost - 60000) < 1, 'avgCost should be the mean of samples');
  assert.equal(result['engine.3'].avgCost, 80000, 'single-sample avgCost should equal that sample');
});

test('statsToHistorical — handles absent or malformed input gracefully', () => {
  assert.deepEqual(statsToHistorical(null), {}, 'null input should return empty object');
  assert.deepEqual(statsToHistorical({}), {}, 'empty stats should return empty object');
  assert.deepEqual(statsToHistorical({ costsByGoalAndRisk: null }), {}, 'null bucket map should return empty');
});
