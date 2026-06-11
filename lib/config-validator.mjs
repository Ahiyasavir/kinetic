// config-validator.mjs — validates autopilot/config.json against the JSON Schema.
// Produces clear, actionable error messages (field path + constraint violated).
// Used as a library (assertValidConfig) by config-loader.mjs for fail-fast startup validation,
// and as a standalone CLI via `npm run validate-config` (exit 0 = valid, 1 = invalid).
//
// Graceful degradation: if ajv or the schema file is unavailable, validation silently skips
// so a fresh install (dev deps not yet hoisted) never blocks the engine from starting.

import { createRequire } from 'node:module';
import { readFileSync, existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const KINETIC_DIR = path.dirname(fileURLToPath(import.meta.url));
const SCHEMA_PATH = path.join(KINETIC_DIR, '../schema/config.schema.json');
const CONFIG_PATH = path.join(KINETIC_DIR, '../config.json');

const _require = createRequire(import.meta.url);

// Compile the schema once; null when ajv or the schema file is unavailable.
let _compiled = null;
let _initDone = false;

function getValidator() {
  if (_initDone) return _compiled;
  _initDone = true;
  if (!existsSync(SCHEMA_PATH)) return null;
  try {
    const AjvMod = _require('ajv');
    const Ajv = AjvMod.default || AjvMod;
    const ajv = new Ajv({ allErrors: true, strict: false });
    const schema = JSON.parse(readFileSync(SCHEMA_PATH, 'utf8'));
    _compiled = ajv.compile(schema);
  } catch {
    _compiled = null;
  }
  return _compiled;
}

/**
 * Format a single ajv error into a human-readable string.
 * e.g.  ".cli.timeoutMs: must be integer"
 */
function formatError(e) {
  const field = e.instancePath || '(root)';
  const detail = e.params && Object.keys(e.params).length
    ? ` (${Object.entries(e.params).map(([k, v]) => `${k}: ${JSON.stringify(v)}`).join(', ')})`
    : '';
  return `  ${field}: ${e.message}${detail}`;
}

/**
 * Validate a config object against the schema.
 * Returns { valid: boolean, errors: string[], skipped: boolean }
 * skipped=true means ajv/schema was unavailable — caller should treat as ok.
 */
export function validateConfig(config) {
  const validate = getValidator();
  if (!validate) return { valid: true, errors: [], skipped: true };
  const valid = validate(config);
  if (valid) return { valid: true, errors: [], skipped: false };
  const errors = (validate.errors || []).map(formatError);
  return { valid: false, errors, skipped: false };
}

/**
 * Validate config and throw with a descriptive message if any schema violations are found.
 * Silently no-ops when ajv / the schema file is unavailable (preserves existing behavior).
 */
export function assertValidConfig(config, source = 'config.json') {
  const { valid, errors, skipped } = validateConfig(config);
  if (skipped || valid) return;
  throw new Error(
    `Invalid ${source} — ${errors.length} schema violation(s):\n${errors.join('\n')}\n` +
    `Fix the fields above or run: npm run validate-config`
  );
}

// CLI entry-point: `node autopilot/lib/config-validator.mjs [path/to/config.json]`
// Exit 0 = valid, Exit 1 = invalid or unreadable.
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const target = process.argv[2] ? path.resolve(process.argv[2]) : CONFIG_PATH;
  try {
    if (!existsSync(target)) {
      console.error(`config-validator: file not found: ${target}`);
      process.exit(1);
    }
    const config = JSON.parse(readFileSync(target, 'utf8'));
    const { valid, errors, skipped } = validateConfig(config);
    if (skipped) {
      console.warn('config-validator: ajv or schema unavailable — validation skipped.');
      process.exit(0);
    }
    if (valid) {
      console.log(`${path.relative(process.cwd(), target)} is valid.`);
      process.exit(0);
    }
    console.error(`${path.relative(process.cwd(), target)} has ${errors.length} schema violation(s):`);
    errors.forEach((e) => console.error(e));
    process.exit(1);
  } catch (err) {
    console.error(`config-validator: ${err.message}`);
    process.exit(1);
  }
}
