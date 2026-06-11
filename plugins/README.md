# plugins/

This directory holds **reusable, project-agnostic extension modules** — integrations and adapters
that are generic enough to be used across projects and can be open-sourced independently of any
commercial deployment.

**Examples of what belongs here:**
- Custom model provider adapters (e.g. a Gemini or Mistral adapter alongside the built-in
  `lib/providers/` adapters).
- Alternative context-provider implementations (plugging into `core/context-provider.mjs`).
- Custom scoring/priority plugins that extend the engine's routing without touching core logic.
- Event-bus integrations (Slack notifier, webhook forwarder, etc.).

**Convention:** each plugin is a self-contained subdirectory with its own `package.json` (or at
minimum an `index.mjs` + `README.md`). Plugins must not import from `../commercial/` — they must
remain free of project-specific secrets and can therefore be distributed separately.

**Wiring a plugin:** register it in `commercial/config.json` via the relevant config key (e.g.
`providers.definitions`, `contextProvider.source`) so the engine discovers it at runtime.

No plugins are bundled by default — the core engine operates without any file in this directory.
