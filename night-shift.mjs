#!/usr/bin/env node
// night-shift.mjs — wait until 1:05 AM local time, then ignite the watchdog loop.
// Run once before sleeping; leave the terminal open. At 1:05 AM it spawns the watchdog
// and the terminal becomes the watchdog's live log for the rest of the night.
import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname  = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT  = path.resolve(__dirname, '..');
const WATCHDOG   = path.join(__dirname, 'watchdog.mjs');

function msUntilTarget() {
  const now = new Date();
  const t   = new Date(now);
  t.setHours(1, 5, 0, 0); // 1:05 AM local
  if (t <= now) t.setDate(t.getDate() + 1); // already past → next day
  return t - now;
}

const ms        = msUntilTarget();
const targetAt  = new Date(Date.now() + ms);
const hh        = String(targetAt.getHours()).padStart(2, '0');
const mm        = String(targetAt.getMinutes()).padStart(2, '0');
const waitMins  = Math.round(ms / 60000);
const waitHrs   = (ms / 3600000).toFixed(2);

console.log('╔══════════════════════════════════════════════════╗');
console.log('║          KINETIC  —  NIGHT SHIFT ARMED           ║');
console.log('╚══════════════════════════════════════════════════╝');
console.log(`  Target    : ${hh}:${mm} local time (${waitMins} min / ${waitHrs} h from now)`);
console.log(`  Watchdog  : ${WATCHDOG}`);
console.log(`  Repo root : ${REPO_ROOT}`);
console.log('');
console.log('  Sleeping … this window will become the watchdog log at ignition.');
console.log('  Close this window to abort before ignition.');
console.log('');

// Tick every 5 min so the window shows it is alive.
const TICK_MS = 5 * 60 * 1000;
const tickInterval = setInterval(() => {
  const remaining = msUntilTarget();
  const rm = Math.ceil(remaining / 60000);
  console.log(`  [${new Date().toLocaleTimeString()}]  T-${rm} min …`);
}, TICK_MS);

setTimeout(() => {
  clearInterval(tickInterval);
  console.log('');
  console.log(`  [${new Date().toLocaleTimeString()}]  ★ IGNITION — spawning watchdog …`);
  console.log('══════════════════════════════════════════════════');

  // Spawn the watchdog with stdio inherited so its output streams into this window.
  // Do NOT detach — this process stays alive as the watchdog's parent, keeping output visible.
  const child = spawn(process.execPath, [WATCHDOG], {
    cwd: REPO_ROOT,
    stdio: 'inherit',
  });

  child.on('error', (err) => {
    console.error(`  [night-shift] Failed to start watchdog: ${err.message}`);
    process.exit(1);
  });

  child.on('exit', (code, signal) => {
    console.log(`\n  [night-shift] Watchdog exited (code=${code} signal=${signal})`);
    process.exit(code ?? 0);
  });

  // Keep the event loop alive — the child's 'exit' event will call process.exit().
}, ms);
