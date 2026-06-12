#!/usr/bin/env node
/**
 * autopilot/telemetry-receiver/setup.mjs
 * One-command telemetry receiver setup — no manual steps required.
 *
 * What it does (fully automated):
 *   1. Checks wrangler is installed (offers to install it)
 *   2. Checks Cloudflare auth (opens browser via wrangler login if needed)
 *   3. Creates the KV namespace (idempotent — skips if already created)
 *   4. Patches wrangler.toml with the KV namespace id
 *   5. Generates a random dashboard secret and sets it via wrangler
 *   6. Deploys the Worker to Cloudflare
 *   7. Parses the live worker URL from deploy output
 *   8. Patches autopilot/config.json with telemetry.endpoint
 *   9. Commits the two changed files
 *
 * Usage:
 *   node autopilot/telemetry-receiver/setup.mjs
 *   node autopilot/telemetry-receiver/setup.mjs --dry-run   # preview only
 *   node autopilot/telemetry-receiver/setup.mjs --skip-commit
 */

import { execSync, spawnSync } from 'child_process';
import { readFileSync, writeFileSync, existsSync } from 'fs';
import { randomBytes } from 'crypto';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT   = path.resolve(__dirname, '..', '..');
const CONFIG_PATH = path.join(REPO_ROOT, 'autopilot', 'config.json');
const TOML_PATH   = path.join(__dirname, 'wrangler.toml');
const WORKER_NAME = 'kinetic-telemetry';

const args = new Set(process.argv.slice(2));
const DRY_RUN     = args.has('--dry-run');
const SKIP_COMMIT = args.has('--skip-commit');

// ── helpers ──────────────────────────────────────────────────────────────────

function step(msg) { console.log(`\n▸ ${msg}`); }
function ok(msg)   { console.log(`  ✓ ${msg}`); }
function info(msg) { console.log(`  · ${msg}`); }
function die(msg)  { console.error(`\n✗ ${msg}`); process.exit(1); }

function run(cmd, opts = {}) {
  const result = spawnSync(cmd, opts.args || [], {
    encoding: 'utf8',
    cwd: opts.cwd || __dirname,
    env: { ...process.env, ...(opts.env || {}) },
    input: opts.input,
    stdio: opts.input != null ? ['pipe', 'pipe', 'pipe'] : ['inherit', 'pipe', 'pipe'],
  });
  if (opts.allowFail) return result;
  if (result.status !== 0) {
    const stderr = (result.stderr || '').trim();
    die(`Command failed: wrangler ${(opts.args || []).join(' ')}\n  ${stderr}`);
  }
  return result;
}

// ── Step 0: check wrangler ───────────────────────────────────────────────────

step('Checking prerequisites');

const wranglerCheck = spawnSync('wrangler', ['--version'], { encoding: 'utf8', stdio: 'pipe' });
if (wranglerCheck.status !== 0) {
  console.error('  ✗ wrangler is not installed.');
  console.error('  Install it with:  npm install -g wrangler');
  console.error('  Then re-run this script.');
  process.exit(1);
}
ok(`wrangler ${(wranglerCheck.stdout || '').trim()}`);

// ── Step 1: Cloudflare auth ──────────────────────────────────────────────────

step('Checking Cloudflare auth');
const whoami = run('wrangler', { args: ['whoami'], allowFail: true });
if (whoami.status !== 0) {
  if (process.env.CLOUDFLARE_API_TOKEN) {
    die('CLOUDFLARE_API_TOKEN is set but wrangler whoami failed — check the token.');
  }
  info('Not logged in. Opening browser for Cloudflare login…');
  if (!DRY_RUN) {
    const login = spawnSync('wrangler', ['login'], { stdio: 'inherit', encoding: 'utf8' });
    if (login.status !== 0) die('wrangler login failed.');
  }
} else {
  const match = (whoami.stdout || '').match(/You are logged in.+?(\S+@\S+)/s);
  ok(match ? `Logged in as ${match[1]}` : 'Logged in');
}

// ── Step 2: KV namespace ─────────────────────────────────────────────────────

step('Provisioning KV namespace');

let kvId;

// Check if wrangler.toml already has a real ID (idempotent re-run)
const existingToml = readFileSync(TOML_PATH, 'utf8');
const alreadyPatched = !existingToml.includes('REPLACE_WITH_YOUR_KV_NAMESPACE_ID');
if (alreadyPatched) {
  const m = existingToml.match(/id\s*=\s*"([a-f0-9]{32})"/);
  if (m) {
    kvId = m[1];
    ok(`KV namespace already configured: ${kvId}`);
  }
}

if (!kvId) {
  // List existing namespaces to avoid creating duplicates
  const listResult = run('wrangler', { args: ['kv', 'namespace', 'list'], allowFail: true });
  if (listResult.status === 0) {
    try {
      const list = JSON.parse(listResult.stdout || '[]');
      const expectedTitle = `${WORKER_NAME}-KINETIC_KV`;
      const found = list.find(ns => ns.title === expectedTitle);
      if (found) {
        kvId = found.id;
        ok(`Reusing existing KV namespace: ${kvId}`);
      }
    } catch { /* parse error — fall through to create */ }
  }
}

if (!kvId && !DRY_RUN) {
  info('Creating KV namespace KINETIC_KV…');
  const createResult = run('wrangler', { args: ['kv', 'namespace', 'create', 'KINETIC_KV'], allowFail: true });
  if (createResult.status !== 0) {
    die(`KV namespace creation failed:\n  ${(createResult.stderr || '').trim()}`);
  }
  // Parse ID from output: looks for a 32-char hex string
  const out = createResult.stdout || '';
  const idMatch = out.match(/"id":\s*"([a-f0-9]{32})"/);
  if (!idMatch) die(`Could not parse KV namespace id from:\n${out}`);
  kvId = idMatch[1];
  ok(`Created KV namespace: ${kvId}`);
}

if (DRY_RUN && !kvId) {
  kvId = 'dry-run-placeholder-00000000000000000000000000';
  info('[dry-run] would create KV namespace');
}

// ── Step 3: patch wrangler.toml ──────────────────────────────────────────────

step('Patching wrangler.toml');
if (!alreadyPatched) {
  const patchedToml = existingToml.replace('REPLACE_WITH_YOUR_KV_NAMESPACE_ID', kvId);
  if (DRY_RUN) {
    info(`[dry-run] would write id = "${kvId}" into wrangler.toml`);
  } else {
    writeFileSync(TOML_PATH, patchedToml, 'utf8');
    ok(`wrangler.toml updated with id = "${kvId}"`);
  }
} else {
  ok('wrangler.toml already patched — skipped');
}

// ── Step 4: dashboard secret ─────────────────────────────────────────────────

step('Setting dashboard secret');
const secret = randomBytes(24).toString('hex');
if (DRY_RUN) {
  info('[dry-run] would set KINETIC_DASHBOARD_SECRET via wrangler secret put');
} else {
  // pipe the secret via stdin so no shell escaping issues on Windows/Linux/macOS
  const secretResult = run('wrangler', {
    args: ['secret', 'put', 'KINETIC_DASHBOARD_SECRET'],
    input: secret,
    allowFail: true,
  });
  if (secretResult.status !== 0) {
    die(`Failed to set secret:\n  ${(secretResult.stderr || '').trim()}`);
  }
  ok('KINETIC_DASHBOARD_SECRET set');
  console.log(`\n  ⚠️  Save this secret — you need it to read /stats:`);
  console.log(`     ${secret}`);
}

// ── Step 5: deploy ───────────────────────────────────────────────────────────

step('Deploying Worker to Cloudflare');
let workerUrl;
if (DRY_RUN) {
  workerUrl = `https://${WORKER_NAME}.YOUR-SUBDOMAIN.workers.dev`;
  info(`[dry-run] would deploy and get URL: ${workerUrl}`);
} else {
  const deployResult = run('wrangler', { args: ['deploy'], allowFail: true });
  if (deployResult.status !== 0) {
    die(`wrangler deploy failed:\n  ${(deployResult.stderr || '').trim()}`);
  }
  const out = deployResult.stdout || '';
  const urlMatch = out.match(/https:\/\/[\w-]+\.[\w-]+\.workers\.dev/);
  if (!urlMatch) die(`Could not parse worker URL from deploy output:\n${out}`);
  workerUrl = urlMatch[0];
  ok(`Deployed: ${workerUrl}`);
}

// ── Step 6: patch config.json ────────────────────────────────────────────────

step('Wiring endpoint into autopilot/config.json');
const endpointUrl = `${workerUrl}/ingest`;
if (DRY_RUN) {
  info(`[dry-run] would set telemetry.endpoint = "${endpointUrl}"`);
} else {
  const cfg = JSON.parse(readFileSync(CONFIG_PATH, 'utf8'));
  cfg.telemetry = cfg.telemetry || {};
  cfg.telemetry.enabled  = true;
  cfg.telemetry.endpoint = endpointUrl;
  writeFileSync(CONFIG_PATH, JSON.stringify(cfg, null, 2) + '\n', 'utf8');
  ok(`config.json → telemetry.endpoint = "${endpointUrl}"`);
}

// ── Step 7: commit ───────────────────────────────────────────────────────────

if (!SKIP_COMMIT && !DRY_RUN) {
  step('Committing changes');
  try {
    execSync(
      `git add autopilot/config.json autopilot/telemetry-receiver/wrangler.toml`,
      { cwd: REPO_ROOT, stdio: 'pipe' }
    );
    execSync(
      `git commit -m "telemetry: deploy receiver + wire live endpoint\n\nWorker: ${workerUrl}\nAuto-generated by autopilot/telemetry-receiver/setup.mjs"`,
      { cwd: REPO_ROOT, stdio: 'pipe' }
    );
    ok('Committed autopilot/config.json + wrangler.toml');
  } catch (e) {
    info(`Could not commit automatically: ${e.message}`);
    info('Run manually:  git add autopilot/config.json autopilot/telemetry-receiver/wrangler.toml && git commit');
  }
}

// ── Done ─────────────────────────────────────────────────────────────────────

console.log(`
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
✅  Telemetry receiver is live and wired.

  Ingest endpoint : ${endpointUrl}
  Stats endpoint  : ${workerUrl}/stats?key=<your-secret>

Every Kinetic cycle from every clone of this repo now reports
automatically — no configuration required by anyone else.
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
`);
