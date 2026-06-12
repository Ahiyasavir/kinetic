intelligence: emit a structured cycle-summary event to the existing telemetry infrastructure after every cycle — the telemetry.mjs module is already enabled (enabled:true in config.json) with recordEvent() and flushTelemetry() wired in, but no cycle-summary event is ever emitted, so the endpoint receives nothing useful.

Changes required in supervisor.mjs only:

1. At the top of runCycle(), record cycleStartMs = Date.now().

2. At every outcome branch (merged / blocked / re-queued-smaller / re-queued-with-memory / blocked-no-change), before saving state, call:
   recordEvent('cycle-summary', {
     cycle: state.cycle,
     outcome,                          // 'merged' | 'blocked' | 're-queued-smaller' | etc.
     taskId: task.id,
     taskGoal: task.goal ?? null,
     taskRisk: task.risk ?? null,
     taskClass: task.class ?? taskClass ?? null,
     modelTier: route?.tierLabel ?? null,   // 'opus' | 'sonnet' | 'haiku'
     blockReason: task.blockReason ?? null,
     durationMs: Date.now() - cycleStartMs,
     inputTokens: currentCycleTokens().input ?? null,
     outputTokens: currentCycleTokens().output ?? null,
     cacheReadTokens: currentCycleTokens().cacheRead ?? null,
     costUsd: currentCycleTokens().cost ?? null,
     revisionCount: attempt,
     validationPassed: validation?.ok ?? null,
     projectId: config.profile ?? 'unknown',
   });

3. After saveState(), call flushTelemetry() (already imported via syncTelemetry path — check the import). It batches internally and only POSTs when batchSize is reached or flushIntervalMs elapses — no per-cycle HTTP call.

4. In config.json, change telemetry.endpoint from null to the deployed worker URL placeholder "https://kinetic-telemetry.SUBDOMAIN.workers.dev/ingest" with a comment "replace SUBDOMAIN after running: cd autopilot/telemetry-receiver && wrangler deploy". Leave enabled:true as-is.

This is a 3-location edit in supervisor.mjs + 1 line in config.json. The telemetry-receiver/ Worker (already written at autopilot/telemetry-receiver/) handles the storage side. Once the endpoint is set, every user who clones the repo reports automatically without any additional configuration.

goal: intelligence risk: 2
