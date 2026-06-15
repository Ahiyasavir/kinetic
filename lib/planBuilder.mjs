// planBuilder.mjs — U-65: render a human-readable plan document from a backlog cost forecast.
//
// The supervisor computes a cost forecast at the start of each cycle (after the Selector ranks tasks,
// before implementation). buildPlan turns that forecast into a markdown plan doc — total cost, the
// estimation methodology, and a per-task cost breakdown — so the plan that gets validated carries the
// forecast it was reasoned from. Pure + synchronous; never throws on a partial/empty forecast.

function normalizeBreakdown(breakdown) {
  if (Array.isArray(breakdown)) return breakdown;
  if (breakdown && typeof breakdown === 'object') {
    return Object.entries(breakdown).map(([key, v]) => ({
      taskId: v && typeof v === 'object' ? (v.taskId ?? key) : key,
      key,
      cost: v && typeof v === 'object' ? (v.cost ?? v.avgCost ?? v.total ?? 0) : Number(v) || 0,
    }));
  }
  return [];
}

/**
 * Build a markdown plan document for `cycleId` from a cost `forecast`.
 *
 * @param {string|number} cycleId
 * @param {{ totalCost?:number, breakdown?:(Array|Object), methodology?:string }} forecast
 * @returns {string} markdown plan document
 */
export function buildPlan(cycleId, forecast) {
  const f = forecast && typeof forecast === 'object' ? forecast : {};
  const total = Number(f.totalCost) || 0;
  const methodology = f.methodology || 'historical-average ([goal][risk] avg from app.stats)';
  const breakdown = normalizeBreakdown(f.breakdown);

  const lines = [
    `# Cycle ${cycleId} — Backlog Cost Forecast Plan`,
    '',
    '## Total cost forecast',
    `Estimated total remaining cost to clear the backlog: ${total}`,
    '',
    '## Methodology',
    `Cost estimation method: ${methodology}. Each task is priced from the historical average of its ` +
      `[goal][risk] bucket, falling back to the task's own cost estimate and then the global average.`,
    '',
    '## Per-task cost breakdown',
  ];

  if (breakdown.length) {
    for (const b of breakdown) {
      const label = b.taskId ?? b.key ?? 'task';
      lines.push(`- ${label}: ${Number(b.cost) || 0}`);
    }
  } else {
    lines.push('- (no backlog tasks to forecast)');
  }

  return lines.join('\n');
}

export default { buildPlan };
