// handoff-schema.mjs — versioned, collision-DETECTABLE schema for the kinetic handoff files (U-34).
//
// lib/handoff-paths.mjs prevents collisions at the FILENAME level (context-tagged basenames). This
// module is the second half of the U-34 contract: a VERSIONED SCHEMA so a handoff/persisted structure
// written by one engine version or project context can be VALIDATED when another reads it back, and a
// drift is REPORTED instead of silently mis-parsed. Every stamped structure carries three envelope
// fields:
//   • version      — integer schema version (HANDOFF_SCHEMA_VERSION); bump on a breaking shape change.
//   • timestamp    — ISO-8601 write time (provenance + ordering across concurrent contexts).
//   • projectScope — the project-context id (lib/handoff-paths.mjs → contextId) the file belongs to, so
//                    a reader can detect a file that drifted in from ANOTHER context sharing the dir.
//
// Backward compatible by design: validateHandoffSchema NEVER throws and NEVER mutates the payload. An
// old/legacy structure missing the envelope is ACCEPTED (treated as v0) with a clear migration message,
// so the engine keeps running instead of corrupting data. This module is project-agnostic (no RushPoint
// specifics) — it mirrors the SCHEMA_VERSION + migrate-on-load pattern already used by lib/state.mjs.

// Bump ONLY on a breaking change to a persisted handoff structure's shape.
export const HANDOFF_SCHEMA_VERSION = 1;

/**
 * Stamp the versioned envelope onto a handoff / persisted payload. Idempotent and non-destructive: an
 * envelope field already present on `payload` is preserved (re-stamping never overwrites an explicit
 * version/timestamp/projectScope). `timestamp` defaults to now; pass an explicit one for resume-safe /
 * deterministic writers.
 */
export function stampHandoff(payload, { context = '', timestamp } = {}) {
  const obj = payload && typeof payload === 'object' ? payload : {};
  return {
    version: HANDOFF_SCHEMA_VERSION,
    timestamp: timestamp || new Date().toISOString(),
    projectScope: context,
    ...obj, // an explicit envelope field on the payload wins → idempotent re-stamp
  };
}

/**
 * Validate a parsed handoff payload's schema envelope on LOAD. Tolerant by contract — returns a verdict
 * object and NEVER throws / mutates `data`:
 *   status 'ok'        version === current               → trusted
 *   status 'unstamped' no integer `version` (legacy/v0)  → accepted, migration message (re-stamp later)
 *   status 'outdated'  0 < version < current             → accepted, migration message
 *   status 'future'    version > current                 → NOT trusted (ok:false), warning message
 * `scopeMismatch` is true when the payload's projectScope is set but differs from the active context —
 * the signal a file from another concurrent context drifted into a shared handoff dir (U-34's purpose).
 */
export function validateHandoffSchema(data, { context = '', file = 'handoff' } = {}) {
  if (!data || typeof data !== 'object') {
    return { ok: false, status: 'empty', version: null, migration: null, scopeMismatch: false, data };
  }
  const hasVersion = Number.isInteger(data.version);
  const version = hasVersion ? data.version : 0;
  let status = 'ok';
  let migration = null;
  if (!hasVersion) {
    status = 'unstamped';
    migration = `${file}: no schema 'version' (legacy/unstamped handoff) — accepting as v0; current is v${HANDOFF_SCHEMA_VERSION}. It will carry the envelope on the next stamped write.`;
  } else if (version < HANDOFF_SCHEMA_VERSION) {
    status = 'outdated';
    migration = `${file}: schema v${version} is older than current v${HANDOFF_SCHEMA_VERSION} — migrating on load (re-stamped on next write).`;
  } else if (version > HANDOFF_SCHEMA_VERSION) {
    status = 'future';
    migration = `${file}: schema v${version} is NEWER than this engine's v${HANDOFF_SCHEMA_VERSION} (written by a newer kinetic?) — not trusting unknown fields.`;
  }
  const scopeMismatch = !!(context && data.projectScope && data.projectScope !== context);
  const ok = version <= HANDOFF_SCHEMA_VERSION; // legacy(0)…current are usable; a future shape is not.
  return { ok, status, version, migration, scopeMismatch, data };
}

/** One-line startup confirmation that handoff schema validation is active (operator-visible). */
export function handoffSchemaResolvedLine() {
  return `handoff schema validation active → version=${HANDOFF_SCHEMA_VERSION} ` +
    `(envelope: version + timestamp + projectScope; legacy/unstamped files accepted as v0).`;
}
