#!/usr/bin/env node
// cli.mjs — Kinetic: a single, package-scoped command router for every kinetic
// workflow. Instead of remembering which file backs which job (supervisor.mjs run, watchdog.mjs,
// config-loader.mjs …), an operator runs ONE entry point:
//
//   node autopilot/cli.mjs <command> [args]
//
// Commands route to their existing handlers UNCHANGED — this is a routing layer, not a behavior
// change. Each handler is spawned as a child process with stdio inherited, so the supervisor /
// watchdog / config-loader behave byte-for-byte as if invoked directly (full backward compatibility:
// `node autopilot/supervisor.mjs run` still works exactly the same). Universal arguments
// (--help / --version / --config / --debug / --verbose) are parsed here once and apply to any command.
//
//   node autopilot/cli.mjs --help
//   node autopilot/cli.mjs --version
//   node autopilot/cli.mjs init                 # → supervisor.mjs init
//   node autopilot/cli.mjs supervisor run        # → supervisor.mjs run
//   node autopilot/cli.mjs watchdog              # → watchdog.mjs
//   node autopilot/cli.mjs config                # → config-loader.mjs (print resolved paths)
//   node autopilot/cli.mjs add "build X"         # → supervisor.mjs add "build X"

import { spawn } from 'node:child_process';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '..');

/** Read the version from the repo's package.json (single source of truth, no duplication). */
export function readVersion() {
  try {
    const pkg = JSON.parse(readFileSync(path.join(REPO_ROOT, 'package.json'), 'utf8'));
    return pkg.version || '0.0.0';
  } catch {
    return '0.0.0';
  }
}

// Command → handler. `script` is the .mjs that owns the workflow; `prepend` is fixed argv injected
// before the user's forwarded args (so a top-level alias like `init` maps onto a supervisor
// subcommand). The supervisor owns its own subcommand set, so we forward verbatim rather than
// re-implementing it here — there is exactly one place that knows what `run|status|add|…` mean.
export const ROUTES = {
  supervisor: { script: 'supervisor.mjs', summary: 'Run/seed/inspect the autonomous loop (run|init|status|start|stop|add|route|reprioritize)' },
  watchdog: { script: 'watchdog.mjs', summary: 'Keep the supervisor alive forever (auto-restart with backoff)' },
  ui: { script: 'ui/server.mjs', summary: 'Launch the local control-center UI (loopback HTTP) — the desktop product surface' },
  config: { script: 'config-loader.mjs', summary: 'Print the resolved config paths / validation / budgets' },
  workspaces: { inline: true, summary: 'List registered workspaces (the picker for a desktop UI) — see also --workspace <id>' },
  // Universal workspace provisioner — runs core/init.mjs against a target repo path.
  provision: { script: 'core/init.mjs', summary: 'Provision a clean autopilot workspace in any git repo (node autopilot/core/init.mjs [path] [--dry-run] [--force])' },
  // Convenience top-level aliases onto the most common supervisor subcommands.
  init: { script: 'supervisor.mjs', prepend: ['init'], summary: 'Seed state/ + starter backlog and set the deadline (= supervisor init)' },
  run: { script: 'supervisor.mjs', prepend: ['run'], summary: 'Start / resume the autonomous loop (= supervisor run)' },
  status: { script: 'supervisor.mjs', prepend: ['status'], summary: 'Print a status snapshot without touching the loop (= supervisor status)' },
  audit: { script: 'supervisor.mjs', prepend: ['audit'], summary: 'Deterministic system self-check ([FILES] [CONFIG] [STATE] [GIT] [LOCKS]); add --verbose for per-check output' },
  start: { script: 'supervisor.mjs', prepend: ['start'], summary: 'Clear STOP + launch the watchdog detached (= supervisor start)' },
  stop: { script: 'supervisor.mjs', prepend: ['stop'], summary: 'Raise STOP + stop watchdog/supervisor (= supervisor stop)' },
  add: { script: 'supervisor.mjs', prepend: ['add'], summary: 'Queue a user task into the inbox (= supervisor add "…")' }
};

/**
 * Split argv into the chosen command, the args forwarded to its handler, and the universal flags.
 * Universal flags are recognised anywhere in argv; the first non-flag token is the command and
 * everything after it is forwarded verbatim to the handler.
 */
export function parseArgs(rawArgs) {
  const flags = { help: false, version: false, debug: false, verbose: false, config: null, workspace: null };
  const forwarded = [];
  let command = null;

  for (let i = 0; i < rawArgs.length; i++) {
    const a = rawArgs[i];
    if (command === null) {
      // Pre-command: universal flags belong to the CLI itself.
      if (a === '--help' || a === '-h') { flags.help = true; continue; }
      if (a === '--version' || a === '-v') { flags.version = true; continue; }
      if (a === '--debug') { flags.debug = true; continue; }
      if (a === '--verbose') { flags.verbose = true; continue; }
      if (a === '--config') { flags.config = rawArgs[++i] ?? ''; continue; }
      if (a.startsWith('--config=')) { flags.config = a.slice('--config='.length); continue; }
      // --workspace / -w selects which registered workspace the command operates on (Goal B/D).
      if (a === '--workspace' || a === '-w') { flags.workspace = rawArgs[++i] ?? ''; continue; }
      if (a.startsWith('--workspace=')) { flags.workspace = a.slice('--workspace='.length); continue; }
      command = a;
      continue;
    }
    // Post-command: --help/--version still resolve to CLI help (handlers don't define them),
    // everything else is forwarded untouched to the handler.
    if (a === '--help' || a === '-h') { flags.help = true; continue; }
    if (a === '--version' || a === '-v') { flags.version = true; continue; }
    forwarded.push(a);
  }
  return { command, forwarded, flags };
}

/** The help text listing every routable command + the universal arguments. */
export function buildHelp() {
  const rows = Object.entries(ROUTES).map(([name, r]) => `  ${name.padEnd(13)} ${r.summary}`).join('\n');
  return [
    `Kinetic CLI  (v${readVersion()})`,
    '',
    'Usage:',
    '  node autopilot/cli.mjs [universal-args] <command> [command-args]',
    '',
    'Commands:',
    rows,
    '',
    'Universal arguments:',
    '  --help, -h        Show this help and exit',
    '  --version, -v     Print the kinetic version and exit',
    '  --workspace, -w <id>  Operate on a registered workspace (exported as KINETIC_WORKSPACE)',
    '  --config <path>   Point the run at an alternate config file (exported as KINETIC_CONFIG)',
    '  --debug           Verbose engine logging (exported as KINETIC_DEBUG=1)',
    '  --verbose         Extra operator output (exported as KINETIC_VERBOSE=1)',
    '',
    'Examples:',
    '  node autopilot/cli.mjs workspaces',
    '  node autopilot/cli.mjs --workspace demo-app status',
    '  node autopilot/cli.mjs init',
    '  node autopilot/cli.mjs supervisor run',
    '  node autopilot/cli.mjs watchdog',
    '  node autopilot/cli.mjs add "make the leaderboard pulse when a team is overtaken"'
  ].join('\n');
}

/** Inline `workspaces` command: print the registered workspaces (the UI picker, on the command line).
 *  `highlightId` marks the one a --workspace flag selected (or validates it: unknown id → error). */
export async function printWorkspaces(highlightId = null) {
  const { getWorkspaces } = await import('./lib/control-api.mjs');
  const { defaultId, warnings, workspaces } = getWorkspaces();
  for (const w of warnings) console.warn(`[kinetic] workspace registry: ${w}`);
  if (highlightId && !workspaces.some((w) => w.id === highlightId)) {
    console.error(`[kinetic] Unknown workspace "${highlightId}". Known: ${workspaces.map((w) => w.id).join(', ') || '(none)'}.`);
    return 1;
  }
  console.log(`Registered workspaces (default: ${defaultId}):\n`);
  for (const w of workspaces) {
    const mark = w.id === (highlightId || defaultId) ? '▶' : ' ';
    console.log(`  ${mark} ${w.id.padEnd(24)} ${w.isDefault ? '[default] ' : ''}${w.label}`);
    console.log(`      root=${w.root} · branch=${w.branch || '(current)'} · budget-scope=${w.budgetScope}`);
  }
  console.log('\nSelect one with:  node autopilot/cli.mjs --workspace <id> <command>');
  return 0;
}

/** Spawn a handler script with stdio inherited so its behavior is byte-identical to a direct run. */
export function runScript(scriptRel, args, env) {
  const scriptPath = path.join(__dirname, scriptRel);
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [scriptPath, ...args], { cwd: REPO_ROOT, stdio: 'inherit', env });
    child.on('exit', (code) => resolve(code ?? 0));
    child.on('error', (e) => { console.error(`[kinetic] failed to launch ${scriptRel}:`, e.message); resolve(1); });
  });
}

/** Route one argv vector to its handler. Returns the process exit code. */
export async function dispatch(rawArgs, baseEnv = process.env) {
  const { command, forwarded, flags } = parseArgs(rawArgs);

  if (flags.version) { console.log(`kinetic ${readVersion()}`); return 0; }
  if (flags.help && !command) { console.log(buildHelp()); return 0; }
  if (!command) { console.log(buildHelp()); return 0; }

  const route = ROUTES[command];
  if (!route) {
    console.error(`[kinetic] Unknown command "${command}".\n`);
    console.log(buildHelp());
    return 1;
  }
  if (flags.help) { console.log(buildHelp()); return 0; }

  // Inline commands run in-process (no child spawn) — used for thin read-only queries a UI consumes.
  if (route.inline) {
    if (command === 'workspaces') return printWorkspaces(flags.workspace);
    console.error(`[kinetic] Inline command "${command}" has no handler.`); return 1;
  }

  // Universal flags are surfaced to handlers as env vars (handlers opt in; absent ⇒ no-op).
  const env = { ...baseEnv };
  if (flags.config != null) env.KINETIC_CONFIG = flags.config;
  if (flags.workspace != null) env.KINETIC_WORKSPACE = flags.workspace; // the supervisor reads this
  if (flags.debug) env.KINETIC_DEBUG = '1';
  if (flags.verbose) env.KINETIC_VERBOSE = '1';

  const args = [...(route.prepend || []), ...forwarded];
  return runScript(route.script, args, env);
}

// CLI entry: run the dispatcher only when executed directly (not when imported for its router).
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  dispatch(process.argv.slice(2))
    .then((code) => process.exit(code))
    .catch((err) => { console.error('[kinetic] Fatal:', err.stack || err.message); process.exit(1); });
}
