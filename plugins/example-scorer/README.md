# example-scorer — custom task-scoring plugin

Demonstrates the `scoreTask` plugin interface documented in `autopilot/docs/INTEGRATION.md §3c`.
Copy this directory to `plugins/my-scorer/`, edit the weights, and register it in your
`commercial/config.json` to override the default `lib/score.mjs` ranking.

## Interface

```js
// plugins/my-scorer/index.mjs
export function scoreTask(task, state, config) { /* → number */ }
export const pluginMeta = { id, type: 'scorer', description, configKey };
```

## Registration

```json
// commercial/config.json
{ "scoring": { "plugin": "plugins/my-scorer/index.mjs" } }
```

> **Status:** wired. `lib/score.mjs` exports `loadScoringPlugin()` and the supervisor calls it
> at startup. Set `scoring.plugin` in `commercial/config.json` and the scorer is active on the
> next `node autopilot/supervisor.mjs run`. See `INTEGRATION.md §3c` for the full wiring guide.

## Constraints

- Must not import from `../commercial/` (keep the plugin secret-free and distributable).
- May import from `../../core/`, `../../lib/`, and `../../shared/`.
