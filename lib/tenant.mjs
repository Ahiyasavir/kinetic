// tenant.mjs — tenant identity utilities for multi-tenant isolation (U-61).
//
// Derives a stable tenant ID from the active workspace and provides the canonical
// state-directory layout for that tenant. The workspace system (workspace.mjs +
// workspace-registry.mjs) already isolates every workspace's state/lock/budget
// paths; this module is the named SEAM that makes the tenant identity explicit so the
// supervisor can log it, tag telemetry events, and compute paths via a single resolved ID.
//
// Single-tenant / default-workspace runs return the workspace's repoGoal id
// (e.g. 'rushpoint-kinetic-topo'), which equals the existing PROJECT_ID — state,
// budgets, and logs are byte-identical to before this change (backward compatible).

import path from 'node:path';
import crypto from 'node:crypto';

// The sentinel tenant ID used when no workspace is configured. Maps to the existing
// state/ layout (no sub-directory) so a plain `node supervisor.mjs run` without a
// --workspace flag is completely unchanged.
export const DEFAULT_TENANT_ID = 'default';

/** Filesystem-safe slug (mirrors workspace.mjs slugId). */
function slugId(s) {
  return String(s || '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
}

/**
 * Resolve the active TENANT ID for this process.
 *
 * Resolution order:
 *   1. workspace.id when a Workspace object is supplied (the standard path through the engine).
 *   2. config.tenantId when set explicitly in config.json (override for advanced deployments).
 *   3. A stable SHA-256 prefix of the workspace root path — gives a consistent, collision-safe
 *      id even with no explicit name (e.g. when workspace.mjs hasn't been initialised yet).
 *
 * @param {object|null} config    — engine config object (used only for the explicit-override fallback)
 * @param {object|null} workspace — Workspace object from workspace.mjs (preferred source)
 * @returns {string} non-empty, filesystem-safe tenant id
 */
export function getTenantId(config, workspace) {
  if (workspace && workspace.id) return workspace.id;
  if (config && config.tenantId) return slugId(config.tenantId);
  // Hash fallback: deterministic short id from the workspace root so concurrent processes on
  // different directories always get distinct, stable ids even without an explicit name.
  const root = (workspace && workspace.root) || (config && config.workspaceRoot) || process.cwd();
  return 'tenant-' + crypto.createHash('sha256').update(root).digest('hex').slice(0, 8);
}

/**
 * Canonical state directory for a given tenant.
 *
 * For DEFAULT_TENANT_ID (no explicit workspace selection) returns `stateRoot` unchanged,
 * preserving the existing state/state.json layout (backward compatibility). For a named
 * tenant, returns the per-tenant subdirectory under state/workspaces/<id>/ — which mirrors
 * the layout that workspaceFromEntry() computes in workspace.mjs.
 *
 * Note: supervisor.mjs consumes the already-resolved WORKSPACE.stateDir directly, so it
 * never needs to call this function itself. getTenantStateDir() is provided as a reusable
 * utility for other engine modules (tests, init scripts, control-api) that need to compute
 * per-tenant paths without constructing a full Workspace object.
 *
 * @param {string} stateRoot — e.g. '/abs/path/autopilot/state' (the engine's state base dir)
 * @param {string} tenantId  — the resolved tenant id from getTenantId()
 * @returns {string} absolute state directory for that tenant
 */
export function getTenantStateDir(stateRoot, tenantId) {
  if (!tenantId || tenantId === DEFAULT_TENANT_ID) return stateRoot;
  return path.join(stateRoot, 'workspaces', tenantId);
}

/**
 * One-line startup confirmation log line for the resolved tenant. Emitted by supervisor.mjs
 * at cmdRun() time so an operator can verify which tenant is active at a glance.
 *
 * @param {string} tenantId   — from getTenantId()
 * @param {object|null} workspace — Workspace object (optional; used only for the source label)
 * @returns {string}
 */
export function tenantResolvedLine(tenantId, workspace) {
  const src = (workspace && !workspace.isDefault)
    ? `workspace "${workspace.id}"`
    : 'default workspace';
  return `tenant id="${tenantId}" (${src}) — state/lock/budget namespaced per-tenant`;
}
