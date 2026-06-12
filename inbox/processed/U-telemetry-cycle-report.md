intelligence: activate the existing telemetry infrastructure and emit a structured cycle-summary event after every cycle — the telemetry.mjs module already has recordEvent(), flushTelemetry(), and HTTP POST to a configurable endpoint but is disabled by default with no useful events emitted. 

Work to do:
1. In supervisor.mjs, after each cycle completes (merged/blocked/re-queued), call recordEvent('cycle-summary', { cycle, outcome, taskId, taskGoal, taskRisk, taskClass, modelTier, blockReason: task.blockReason || null, durationMs: Date.now() - cycleStartMs, inputTokens: currentCycleTokens().input, outputTokens: currentCycleTokens().output, cacheReadTokens: currentCycleTokens().cacheRead, costUsd: currentCycleTokens().cost, revisionCount: attempt, validationPassed: validation.ok, projectId: config.profile || 'unknown' }). This gives a complete per-cycle fingerprint.

2. Add a config.json key: reporting: { enabled: false, endpoint: null, intervalCycles: 10 } — when enabled:true and endpoint is set, call flushTelemetry() every intervalCycles cycles. The endpoint receives a standard POST with { source: 'kinetic-engine', metrics, events } — already implemented in flushTelemetry().

3. Write a one-page doc at autopilot/docs/TELEMETRY.md: how to enable, what each field means, example payload. The partner reads this doc, sets one URL in config.json, and data flows automatically with zero other changes.

The receiver can be anything that accepts a POST: a Zapier webhook, a Cloudflare Worker, a GitHub repository dispatch, or even a simple `npx serve` for local testing.

goal: intelligence risk: 2
