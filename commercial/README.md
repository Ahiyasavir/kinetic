# commercial/

This directory contains **project-specific commercial bindings** for the autopilot engine — the
configuration and secrets that are private to a particular deployment.

**What lives here:**
- `config.json` — the canonical engine configuration for this project (model selection, scoring
  weights, validation commands, git targets, API keys references, budget limits, and all
  project-specific overrides). The engine reads `commercial/config.json` first; it falls back to
  the legacy root `config.json` so existing setups keep working without change.

**What does NOT live here:**
- Engine code (`../core/`, `../lib/`) — project-agnostic, open-sourceable.
- Reusable plugin modules (`../plugins/`) — generic integrations, open-sourceable.
- Universal type contracts (`../shared/`) — schema definitions, open-sourceable.

**Security:** this directory is inside `/autopilot/` which is gitignored in the host repository.
API key environment variable names (not the keys themselves) live in `config.json → api_pools[].key_env`
— the actual secrets are never written to disk, only read from `process.env` at runtime.

**Onboarding a new project:** copy `config.json.example` from the repo root to
`autopilot/commercial/config.json` and fill in your project-specific values. The engine detects
the file automatically — no code change required.
