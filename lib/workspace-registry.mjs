// workspace-registry.mjs — the workspace selection layer.
//
// A registry lists the workspaces this machine knows about. It is read from autopilot/workspaces.json
// when present; the DEFAULT workspace (the engine's existing config-derived target — i.e. RushPoint, now
// "just one workspace") is ALWAYS present and is the fallback, so the engine works with no registry file
// at all (fully backward compatible). Selection is EXPLICIT: an unknown id is a hard error — we never
// silently fall back to a different workspace than the one the operator named (a safety property: you
// can't accidentally run against the wrong folder).
//
// File format (autopilot/workspaces.json):
//   {
//     "default": "rushpoint-kinetic-topo",         // optional: which id is the default selection
//     "workspaces": [
//       { "id": "demo", "label": "Demo App", "root": "../demo-app", "branch": "main",
//         "integrationBranch": "autopilot/demo", "baseBranch": "main",
//         "validation": { "commands": [{ "name": "typecheck", "cmd": "npm run typecheck", "required": true, "timeoutMs": 600000 }] },
//         "boundaries": { "write": ["."], "read": ["."] } }
//     ]
//   }
// Every field except `root` is optional; omitted fields fall back to safe engine defaults
// (see workspaceFromEntry). The config-derived default workspace is appended automatically.
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { queuePaths } from '../config-loader.mjs';
import { defaultWorkspace, workspaceFromEntry } from './workspace.mjs';
import { EngineError } from './engine-error.mjs';

export const REGISTRY_PATH = path.join(queuePaths.autopilotDir, 'workspaces.json');

// Read + parse the registry file. Graceful: missing/corrupt → { workspaces: [] } (never throws into
// the engine; a corrupt file is reported via the returned `warning`, not by crashing).
function readRegistryFile(registryPath) {
  if (!existsSync(registryPath)) return { workspaces: [] };
  try {
    const d = JSON.parse(readFileSync(registryPath, 'utf8'));
    return {
      default: typeof d.default === 'string' ? d.default : null,
      workspaces: Array.isArray(d.workspaces) ? d.workspaces : [],
    };
  } catch (e) {
    return { workspaces: [], warning: `workspaces.json unreadable (${e.message}) — using the default workspace only.` };
  }
}

/**
 * Build the full registry: the always-present default workspace + every valid file entry. A file entry
 * whose id collides with the default is skipped (the config-derived default wins). An entry that fails
 * to build (e.g. missing root) is dropped with a recorded warning rather than crashing the registry.
 * @param {{registryPath?:string, gitRootOverride?:string}} [opts]
 */
export function loadRegistry(opts = {}) {
  const registryPath = opts.registryPath || REGISTRY_PATH;
  const def = defaultWorkspace({ gitRootOverride: opts.gitRootOverride });
  const file = readRegistryFile(registryPath);
  const warnings = file.warning ? [file.warning] : [];

  const byId = new Map([[def.id, def]]);
  const order = [def.id];
  for (const entry of file.workspaces) {
    try {
      const ws = workspaceFromEntry(entry);
      if (byId.has(ws.id)) { warnings.push(`workspace "${ws.id}" duplicates the default — file entry ignored.`); continue; }
      byId.set(ws.id, ws);
      order.push(ws.id);
    } catch (e) {
      warnings.push(`skipped invalid workspace entry (${e.message}).`);
    }
  }
  // The configured default selection: an explicit file `default` (if it resolves), else the config-derived one.
  const defaultId = (file.default && byId.has(file.default)) ? file.default : def.id;
  return {
    defaultId,
    workspaces: order.map((id) => byId.get(id)),
    byId,
    warnings,
    fromFile: existsSync(registryPath) && !file.warning,
  };
}

/** UI-ready list of registered workspaces. */
export function listWorkspaces(registry) {
  return registry.workspaces.map((ws) => ({
    id: ws.id, label: ws.label, isDefault: ws.id === registry.defaultId, root: ws.root,
    branch: ws.git.branch || null, budgetScope: ws.budgetScope,
  }));
}

/**
 * Select ONE workspace by id. `null`/`undefined`/'' → the registry's default. An unknown id throws —
 * never a silent fallback (you cannot accidentally operate on the wrong workspace).
 */
export function selectWorkspace(registry, id) {
  if (id == null || id === '') return registry.byId.get(registry.defaultId);
  const ws = registry.byId.get(id);
  if (!ws) {
    const known = [...registry.byId.keys()].join(', ') || '(none)';
    throw new EngineError(`Unknown workspace "${id}". Known workspaces: ${known}.`, { code: 'WORKSPACE_UNKNOWN' });
  }
  return ws;
}

/**
 * The one call the engine entry-points use: resolve the ACTIVE workspace from the environment.
 *   envId           — KINETIC_WORKSPACE (operator's explicit choice; absent → default)
 *   gitRootOverride — KINETIC_GIT_ROOT (watchdog's working-tree export; applies to the default ws)
 * Returns { workspace, registry } so callers can also log/inspect the registry + warnings.
 */
export function resolveActiveWorkspace({ envId = null, gitRootOverride = null, registryPath = null } = {}) {
  const registry = loadRegistry({ registryPath, gitRootOverride });
  const workspace = selectWorkspace(registry, envId);
  return { workspace, registry };
}
