// generateIntent.mjs — write intent.md immediately after Selector phase, before implementation.
// The intent document captures the micro-plan, cost forecast, and validation score so every cycle
// has a committed, auditable statement of intent before any code changes begin.

/**
 * Compose intent.md content and return metadata for the caller to write + commit.
 * This function is synchronous and pure (no file I/O) so it is fully testable.
 * The caller (supervisor planningGatePhase) is responsible for writing and committing the file.
 *
 * @param {{ plan: string, validationScore: number, steps?: string[] }} microplan
 * @param {{ totalCost: number, breakdown: object }} forecast
 * @param {number} score - validation score (same as microplan.validationScore)
 * @returns {{ filePath: string, committed: boolean, content: string }}
 */
export function writeIntentMarkdown(microplan, forecast, score) {
  const plan = (microplan && microplan.plan) || '(no plan)';
  const steps = (microplan && microplan.steps) || [];
  const totalCost = (forecast && forecast.totalCost) != null ? (forecast && forecast.totalCost) : 0;

  const lines = [
    '# intent.md — Planning Gate',
    '',
    `**Validation Score:** ${score}`,
    `**Forecast Total Cost:** ${totalCost}`,
    '',
    '## Micro-Plan',
    plan,
    '',
  ];

  if (steps.length > 0) {
    lines.push('## Steps');
    for (const step of steps) lines.push(`- ${step}`);
    lines.push('');
  }

  lines.push('## Forecast Breakdown');
  lines.push('```json');
  lines.push(JSON.stringify(forecast || {}, null, 2));
  lines.push('```');
  lines.push('');

  const content = lines.join('\n');
  const filePath = 'autopilot/state/intent.md';

  return { filePath, committed: false, content };
}
