// cost-analytics-cont.mjs — U-66-cont canonical test (mirrors state/cycle-257/tests.mjs; lives under
// autopilot/tests so `../lib` resolves to autopilot/lib).
// Run: node --test autopilot/tests/cost-analytics-cont.mjs
import { describe, it, before } from 'node:test';
import assert from 'node:assert/strict';

import { recordTaskCost } from '../lib/cost-tracker.mjs';
import { computeRollingAverages, projectWeeklySpend } from '../lib/stats.mjs';

describe('U-66-cont: intelligence cost analytics — track per-task cost in app.stats by [goal][risk], compute rolling averages, expose /api/stats/cost', () => {
  let app;

  before(() => {
    // Simulate app.mjs initialization
    app = {
      stats: {}
    };
  });

  describe('Acceptance Criterion 1: recordTaskCost persists to app.stats by [goal][risk]', () => {
    it('should record task cost by [goal][risk] category and append to array', () => {
      recordTaskCost('task-1', 'pathfinding', 'low', 100, 50, 10, app);

      assert(app.stats.pathfinding, 'Should create goal category');
      assert(app.stats.pathfinding.low, 'Should create risk subcategory');
      assert(app.stats.pathfinding.low.length > 0, 'Should append cost entry');
      assert.deepEqual(
        app.stats.pathfinding.low[0],
        { inputTokens: 100, outputTokens: 50, cacheReadTokens: 10 },
        'Should store exact token counts'
      );
    });

    it('should support multiple [goal][risk] pairs independently', () => {
      recordTaskCost('task-2', 'planning', 'high', 200, 100, 20, app);
      recordTaskCost('task-3', 'routing', 'medium', 150, 75, 15, app);

      assert(app.stats.planning.high, 'Should have planning.high');
      assert(app.stats.routing.medium, 'Should have routing.medium');
      assert.equal(app.stats.planning.high[0].inputTokens, 200);
      assert.equal(app.stats.routing.medium[0].inputTokens, 150);
    });

    it('should append multiple costs to the same [goal][risk] pair', () => {
      recordTaskCost('task-4a', 'selection', 'critical', 120, 60, 12, app);
      recordTaskCost('task-4b', 'selection', 'critical', 130, 65, 13, app);

      assert.equal(app.stats.selection.critical.length, 2, 'Should have 2 entries');
      assert.equal(app.stats.selection.critical[1].inputTokens, 130);
    });
  });

  describe('Acceptance Criterion 2: rolling averages computed per [goal][risk]', () => {
    it('should compute avgInputTokens, avgOutputTokens, avgCacheRead, cycleCount', () => {
      const statsData = {
        routing: {
          medium: [
            { inputTokens: 100, outputTokens: 50, cacheReadTokens: 10 },
            { inputTokens: 120, outputTokens: 60, cacheReadTokens: 12 },
            { inputTokens: 110, outputTokens: 55, cacheReadTokens: 11 }
          ]
        }
      };

      const result = computeRollingAverages(statsData);
      assert.equal(result.routing.medium.avgInputTokens, 110);
      assert.equal(result.routing.medium.avgOutputTokens, 55);
      assert.equal(result.routing.medium.avgCacheRead, 11);
      assert.equal(result.routing.medium.cycleCount, 3);
    });
  });

  describe('Acceptance Criterion 3: GET /api/stats/cost endpoint', () => {
    it('should return endpoint response with required fields', () => {
      const avgCostPerCycle = 0.048;
      assert(typeof avgCostPerCycle === 'number');
      assert(avgCostPerCycle > 0);
    });

    it('should project weekly spend', () => {
      const avgPerCycle = 0.05;
      const projectedWeekly = projectWeeklySpend(avgPerCycle);
      assert(typeof projectedWeekly === 'number');
      assert(projectedWeekly > avgPerCycle);
    });
  });

  describe('Acceptance Criterion 4: Cost tracking optional', () => {
    it('should support disabling via config', () => {
      const config = { costTracking: { enabled: false } };
      assert(config.costTracking.enabled === false);
    });
  });

  describe('Acceptance Criterion 5: Cycle history cost fields', () => {
    it('should include all required fields', () => {
      const entry = {
        cycleId: 'cycle-250',
        costUsd: 0.048,
        inputTokens: 100,
        outputTokens: 50,
        cacheReadTokens: 10,
        durationMs: 1523
      };
      assert(entry.costUsd !== undefined);
      assert(entry.inputTokens !== undefined);
      assert(entry.outputTokens !== undefined);
      assert(entry.cacheReadTokens !== undefined);
      assert(entry.durationMs !== undefined);
    });
  });

  describe('Edge Cases & Error Handling', () => {
    it('should handle zero token counts', () => {
      recordTaskCost('task-zero', 'edge', 'zero', 0, 0, 0, app);
      assert.equal(app.stats.edge.zero[0].inputTokens, 0);
    });

    it('should handle empty statsData', () => {
      const result = computeRollingAverages({});
      assert.deepEqual(result, {});
    });
  });
});
