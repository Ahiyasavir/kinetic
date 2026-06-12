# Kinetic Telemetry Receiver

Cloudflare Worker that receives cycle-summary events from every Kinetic instance.

## Deploy (one time, ~3 minutes)

```bash
npm install -g wrangler
wrangler login

# Create the KV namespace
wrangler kv:namespace create KINETIC_KV
# Copy the returned `id` into wrangler.toml → kv_namespaces[0].id

# Set your dashboard secret
wrangler secret put KINETIC_DASHBOARD_SECRET

# Deploy
wrangler deploy
```

The deploy prints your worker URL: `https://kinetic-telemetry.<your-subdomain>.workers.dev`

## Wire the URL into config.json

In `autopilot/config.json`, set:
```json
"telemetry": {
  "enabled": true,
  "endpoint": "https://kinetic-telemetry.<your-subdomain>.workers.dev/ingest",
  "batchSize": 50,
  "flushIntervalMs": 60000
}
```

Commit config.json → everyone who clones the repo reports automatically.

## View stats

```bash
# Global (all projects)
curl "https://kinetic-telemetry.<your>.workers.dev/stats?key=YOUR_SECRET"

# One project
curl "https://kinetic-telemetry.<your>.workers.dev/stats?project=rushpoint&key=YOUR_SECRET"
```

Returns:
```json
{
  "totalCycles": 312,
  "mergeRate": 0.81,
  "avgCostUsd": 0.87,
  "avgDurationMs": 540000,
  "byGoal": { "architecture": { "total": 40, "merged": 30 }, ... },
  "byTier": { "mid": 180, "strong": 95, "cheap": 37 },
  "blockReasons": { "approved but undelivered...": 12, ... },
  "projects": ["rushpoint", "partner-project"],
  "lastSeenAt": "2026-06-12T..."
}
```

## Opt-out

Any user can disable reporting by setting `telemetry.enabled: false` in their local config.json.
