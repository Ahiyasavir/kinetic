// cost-analytics.mjs — U-66-cont canonical test (mirrors state/cycle-252/tests.mjs; lives under
// autopilot/tests so `../lib` resolves to autopilot/lib).
// Run: node --test autopilot/tests/cost-analytics.mjs
import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { trackTaskCost } from '../lib/cost-tracker.mjs';
import { computeStats } from '../lib/cost-stats.mjs';
import { projectWeeklyCost } from '../lib/cost-projector.mjs';

describe('U-66-cont: Intelligence Cost Analytics — track per-task actual cost in app.stats keyed by [goal][risk], compute rolling averages, and expose GET /api/stats/cost', () => {
  let appStats;

  beforeEach(() => {
    appStats = {};
  });

  // Acceptance Criterion 1: recordTaskCost is called at task end and persists to app.stats
  describe('AC1: Cost Recording & Persistence', () => {
    it('should record task cost with [goal][risk] key structure', () => {
      const tokens = {
        inputTokens: 150,
        outputTokens: 75,
        cacheReadTokens: 40,
      };
      trackTaskCost(appStats, 'planning', 'high', tokens);

      assert.ok(appStats.planning, 'should have goal key (planning)');
      assert.ok(appStats.planning.high, 'should have risk key (high)');
      assert.ok(Array.isArray(appStats.planning.high), 'app.stats[goal][risk] should be array');
      assert.equal(appStats.planning.high.length, 1, 'should record first entry');
    });

    it('should persist all three token types: inputTokens, outputTokens, cacheReadTokens', () => {
      const tokens = {
        inputTokens: 100,
        outputTokens: 50,
        cacheReadTokens: 25,
      };
      trackTaskCost(appStats, 'execution', 'medium', tokens);

      const entry = appStats.execution.medium[0];
      assert.equal(entry.inputTokens, 100, 'inputTokens should match');
      assert.equal(entry.outputTokens, 50, 'outputTokens should match');
      assert.equal(entry.cacheReadTokens, 25, 'cacheReadTokens should match');
    });

    it('should append multiple cost entries for same [goal][risk]', () => {
      trackTaskCost(appStats, 'planning', 'high', { inputTokens: 100, outputTokens: 50, cacheReadTokens: 10 });
      trackTaskCost(appStats, 'planning', 'high', { inputTokens: 200, outputTokens: 100, cacheReadTokens: 20 });

      assert.equal(appStats.planning.high.length, 2, 'should have 2 entries');
    });

    it('should isolate different [goal][risk] combinations', () => {
      trackTaskCost(appStats, 'planning', 'high', { inputTokens: 100, outputTokens: 50, cacheReadTokens: 10 });
      trackTaskCost(appStats, 'planning', 'low', { inputTokens: 80, outputTokens: 40, cacheReadTokens: 8 });
      trackTaskCost(appStats, 'execution', 'high', { inputTokens: 120, outputTokens: 60, cacheReadTokens: 12 });

      assert.equal(appStats.planning.high.length, 1);
      assert.equal(appStats.planning.low.length, 1);
      assert.equal(appStats.execution.high.length, 1);
    });
  });

  // Acceptance Criterion 2: app.stats contains rolling average cost metrics
  describe('AC2: Rolling Averages & Metrics', () => {
    it('should maintain rolling array limited to last 10 entries per [goal][risk]', () => {
      for (let i = 0; i < 15; i++) {
        trackTaskCost(appStats, 'planning', 'high', {
          inputTokens: 100 + i * 10,
          outputTokens: 50 + i * 5,
          cacheReadTokens: 10 + i,
        });
      }

      assert.equal(appStats.planning.high.length, 10, 'rolling window should cap at 10');
    });

    it('should compute avgInputTokens from rolling window', () => {
      trackTaskCost(appStats, 'planning', 'high', { inputTokens: 100, outputTokens: 50, cacheReadTokens: 10 });
      trackTaskCost(appStats, 'planning', 'high', { inputTokens: 200, outputTokens: 100, cacheReadTokens: 20 });

      const stats = computeStats(appStats);

      assert.ok(stats.planning, 'should compute goal-level stats');
      assert.ok(stats.planning.high, 'should compute risk-level stats');
      assert.equal(stats.planning.high.avgInputTokens, 150, 'avgInputTokens should be (100+200)/2');
    });

    it('should compute avgOutputTokens from rolling window', () => {
      trackTaskCost(appStats, 'planning', 'high', { inputTokens: 100, outputTokens: 50, cacheReadTokens: 10 });
      trackTaskCost(appStats, 'planning', 'high', { inputTokens: 200, outputTokens: 100, cacheReadTokens: 20 });

      const stats = computeStats(appStats);

      assert.equal(stats.planning.high.avgOutputTokens, 75, 'avgOutputTokens should be (50+100)/2');
    });

    it('should compute avgCacheRead from rolling window', () => {
      trackTaskCost(appStats, 'planning', 'high', { inputTokens: 100, outputTokens: 50, cacheReadTokens: 10 });
      trackTaskCost(appStats, 'planning', 'high', { inputTokens: 200, outputTokens: 100, cacheReadTokens: 20 });

      const stats = computeStats(appStats);

      assert.equal(stats.planning.high.avgCacheRead, 15, 'avgCacheRead should be (10+20)/2');
    });

    it('should track cycleCount for each [goal][risk]', () => {
      trackTaskCost(appStats, 'planning', 'high', { inputTokens: 100, outputTokens: 50, cacheReadTokens: 10 });
      trackTaskCost(appStats, 'planning', 'high', { inputTokens: 200, outputTokens: 100, cacheReadTokens: 20 });
      trackTaskCost(appStats, 'planning', 'high', { inputTokens: 150, outputTokens: 75, cacheReadTokens: 15 });

      const stats = computeStats(appStats);

      assert.equal(stats.planning.high.cycleCount, 3, 'cycleCount should be 3');
    });
  });

  // Acceptance Criterion 3: GET /api/stats/cost endpoint
  describe('AC3: Stats Endpoint Contract', () => {
    it('should compute totalCycles as sum of all [goal][risk] cycle counts', () => {
      trackTaskCost(appStats, 'planning', 'high', { inputTokens: 100, outputTokens: 50, cacheReadTokens: 10 });
      trackTaskCost(appStats, 'planning', 'low', { inputTokens: 80, outputTokens: 40, cacheReadTokens: 8 });
      trackTaskCost(appStats, 'execution', 'high', { inputTokens: 120, outputTokens: 60, cacheReadTokens: 12 });

      const stats = computeStats(appStats);

      assert.ok(stats.totalCycles !== undefined, 'should compute totalCycles');
      assert.equal(stats.totalCycles, 3, 'totalCycles should sum all cycles across goals/risks');
    });

    it('should compute avgCostPerCycle as weighted average across all goals/risks', () => {
      trackTaskCost(appStats, 'planning', 'high', { inputTokens: 100, outputTokens: 50, cacheReadTokens: 10 });
      trackTaskCost(appStats, 'planning', 'high', { inputTokens: 200, outputTokens: 100, cacheReadTokens: 20 });

      const stats = computeStats(appStats);

      assert.ok(typeof stats.avgCostPerCycle === 'number', 'avgCostPerCycle should be numeric');
      assert.ok(stats.avgCostPerCycle > 0, 'avgCostPerCycle should be positive');
    });

    it('should include byGoal breakdown with stats per goal', () => {
      trackTaskCost(appStats, 'planning', 'high', { inputTokens: 100, outputTokens: 50, cacheReadTokens: 10 });
      trackTaskCost(appStats, 'execution', 'high', { inputTokens: 150, outputTokens: 75, cacheReadTokens: 15 });

      const stats = computeStats(appStats);

      assert.ok(stats.byGoal, 'should have byGoal breakdown');
      assert.ok(stats.byGoal.planning, 'should have planning goal stats');
      assert.ok(stats.byGoal.execution, 'should have execution goal stats');
      assert.ok(stats.byGoal.planning.totalInputTokens !== undefined, 'goal stats should aggregate token sums');
    });

    it('should include byRisk breakdown with stats per risk level', () => {
      trackTaskCost(appStats, 'planning', 'high', { inputTokens: 100, outputTokens: 50, cacheReadTokens: 10 });
      trackTaskCost(appStats, 'planning', 'low', { inputTokens: 50, outputTokens: 25, cacheReadTokens: 5 });

      const stats = computeStats(appStats);

      assert.ok(stats.byRisk, 'should have byRisk breakdown');
      assert.ok(stats.byRisk.high, 'should have high risk stats');
      assert.ok(stats.byRisk.low, 'should have low risk stats');
      assert.ok(stats.byRisk.high.totalInputTokens !== undefined, 'risk stats should aggregate token sums');
    });

    it('should compute projectedWeeklySpend from avgCostPerCycle', () => {
      trackTaskCost(appStats, 'planning', 'high', { inputTokens: 1000, outputTokens: 500, cacheReadTokens: 100 });

      const stats = computeStats(appStats);
      const projected = projectWeeklyCost(stats.avgCostPerCycle);

      assert.ok(typeof projected === 'number', 'projectedWeeklySpend should be numeric');
      assert.ok(projected > 0, 'projectedWeeklySpend should be positive');
    });

    it('should compute variance of token costs', () => {
      trackTaskCost(appStats, 'planning', 'high', { inputTokens: 100, outputTokens: 50, cacheReadTokens: 10 });
      trackTaskCost(appStats, 'planning', 'high', { inputTokens: 200, outputTokens: 100, cacheReadTokens: 20 });
      trackTaskCost(appStats, 'planning', 'high', { inputTokens: 150, outputTokens: 75, cacheReadTokens: 15 });

      const stats = computeStats(appStats);

      assert.ok(stats.variance !== undefined, 'should compute variance metric');
      assert.ok(stats.variance >= 0, 'variance should be non-negative');
    });
  });

  // Acceptance Criterion 4: Cost tracking is optional
  describe('AC4: Optional Cost Tracking (Graceful Degradation)', () => {
    it('should handle empty app.stats gracefully in computeStats', () => {
      const stats = computeStats({});

      assert.ok(stats !== undefined, 'should return valid object for empty stats');
      assert.equal(stats.totalCycles, 0, 'totalCycles should be 0 for empty stats');
    });

    it('should compute correct stats with single cycle entry', () => {
      trackTaskCost(appStats, 'planning', 'high', { inputTokens: 100, outputTokens: 50, cacheReadTokens: 10 });

      const stats = computeStats(appStats);

      assert.equal(stats.planning.high.avgInputTokens, 100);
      assert.equal(stats.planning.high.avgOutputTokens, 50);
      assert.equal(stats.planning.high.avgCacheRead, 10);
      assert.equal(stats.planning.high.cycleCount, 1);
    });

    it('should not throw when projecting cost with zero avgCostPerCycle', () => {
      const projected = projectWeeklyCost(0);

      assert.ok(typeof projected === 'number', 'should return numeric value');
      assert.equal(projected, 0, 'should return 0 for 0 input');
    });
  });

  // Edge Cases & Error Handling
  describe('Edge Cases & Error Handling', () => {
    it('should preserve oldest entries when rolling window fills exactly to 10', () => {
      for (let i = 0; i < 10; i++) {
        trackTaskCost(appStats, 'planning', 'high', {
          inputTokens: 100 * (i + 1),
          outputTokens: 50 * (i + 1),
          cacheReadTokens: 10 * (i + 1),
        });
      }

      assert.equal(appStats.planning.high.length, 10, 'should have exactly 10 entries');
    });

    it('should drop oldest entry when rolling window exceeds 10', () => {
      const firstEntry = { inputTokens: 1, outputTokens: 1, cacheReadTokens: 1 };
      trackTaskCost(appStats, 'planning', 'high', firstEntry);

      for (let i = 0; i < 10; i++) {
        trackTaskCost(appStats, 'planning', 'high', {
          inputTokens: 100 + i * 10,
          outputTokens: 50 + i * 5,
          cacheReadTokens: 10 + i,
        });
      }

      assert.equal(appStats.planning.high.length, 10, 'should remain at 10 entries');
      assert.notDeepEqual(
        appStats.planning.high[0],
        firstEntry,
        'first entry should be dropped when window exceeds capacity'
      );
    });

    it('should handle mixed goals and risks without cross-contamination', () => {
      trackTaskCost(appStats, 'planning', 'high', { inputTokens: 100, outputTokens: 50, cacheReadTokens: 10 });
      trackTaskCost(appStats, 'planning', 'low', { inputTokens: 80, outputTokens: 40, cacheReadTokens: 8 });
      trackTaskCost(appStats, 'execution', 'high', { inputTokens: 120, outputTokens: 60, cacheReadTokens: 12 });
      trackTaskCost(appStats, 'execution', 'low', { inputTokens: 90, outputTokens: 45, cacheReadTokens: 9 });

      const stats = computeStats(appStats);

      assert.equal(stats.planning.high.cycleCount, 1);
      assert.equal(stats.planning.low.cycleCount, 1);
      assert.equal(stats.execution.high.cycleCount, 1);
      assert.equal(stats.execution.low.cycleCount, 1);
      assert.equal(stats.totalCycles, 4);
    });

    it('should compute variance correctly with 2 entries', () => {
      trackTaskCost(appStats, 'planning', 'high', { inputTokens: 100, outputTokens: 50, cacheReadTokens: 10 });
      trackTaskCost(appStats, 'planning', 'high', { inputTokens: 200, outputTokens: 100, cacheReadTokens: 20 });

      const stats = computeStats(appStats);

      assert.ok(stats.variance > 0, 'variance should be non-zero for different values');
    });

    it('should compute zero variance with identical entries', () => {
      trackTaskCost(appStats, 'planning', 'high', { inputTokens: 100, outputTokens: 50, cacheReadTokens: 10 });
      trackTaskCost(appStats, 'planning', 'high', { inputTokens: 100, outputTokens: 50, cacheReadTokens: 10 });

      const stats = computeStats(appStats);

      assert.equal(stats.variance, 0, 'variance should be 0 when all entries are identical');
    });

    it('should project weekly spend proportionally to avgCostPerCycle', () => {
      const cost1 = projectWeeklyCost(100);
      const cost2 = projectWeeklyCost(200);

      assert.ok(cost2 > cost1, 'higher avgCostPerCycle should result in higher weekly projection');
      assert.ok(cost2 / cost1 > 1.5, 'projection should scale with input');
    });

    it('should handle trackTaskCost with zero token values', () => {
      trackTaskCost(appStats, 'planning', 'high', { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0 });

      const stats = computeStats(appStats);

      assert.equal(stats.planning.high.avgInputTokens, 0);
      assert.equal(stats.planning.high.avgOutputTokens, 0);
      assert.equal(stats.planning.high.avgCacheRead, 0);
    });

    it('should compute correct byGoal aggregates across multiple risks', () => {
      trackTaskCost(appStats, 'planning', 'high', { inputTokens: 100, outputTokens: 50, cacheReadTokens: 10 });
      trackTaskCost(appStats, 'planning', 'low', { inputTokens: 200, outputTokens: 100, cacheReadTokens: 20 });

      const stats = computeStats(appStats);

      assert.ok(stats.byGoal.planning.totalInputTokens !== undefined);
      assert.equal(stats.byGoal.planning.totalInputTokens, 300, 'byGoal.planning should aggregate both risks');
    });

    it('should compute correct byRisk aggregates across multiple goals', () => {
      trackTaskCost(appStats, 'planning', 'high', { inputTokens: 100, outputTokens: 50, cacheReadTokens: 10 });
      trackTaskCost(appStats, 'execution', 'high', { inputTokens: 200, outputTokens: 100, cacheReadTokens: 20 });

      const stats = computeStats(appStats);

      assert.ok(stats.byRisk.high.totalInputTokens !== undefined);
      assert.equal(stats.byRisk.high.totalInputTokens, 300, 'byRisk.high should aggregate both goals');
    });
  });
});
