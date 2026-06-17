// ui/server.mjs — the LOCAL control server: the clean API boundary between the engine and a desktop
// UI. It wraps lib/control-api.mjs over HTTP (JSON) and serves the static control-center UI. It is the
// ONLY thing the UI talks to — the UI never imports engine internals, so it cannot bypass workspace
// boundaries (it only names a workspace id; the engine resolves + scopes everything).
//
// Safety:
//   • binds 127.0.0.1 ONLY (never 0.0.0.0) — not reachable from the network.
//   • every workspace-scoped route requires an explicit ?ws=<id>; an unknown id is a 400 (no silent
//     fallback), exactly like the CLI.
//   • request bodies are size-capped; only Node built-ins are used (no deps → trivially packageable
//     inside an Electron/Tauri/pkg shell later).
//   • the engine loop is NOT started by importing this server; /api/start is an explicit, opt-in action.
//
// Run:  node autopilot/cli.mjs ui        (→ prints the local URL)
import http from 'node:http';
import { readFileSync, existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import * as api from '../lib/control-api.mjs';
import { readVersion } from '../cli.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC_DIR = path.join(__dirname, 'public');
const CLI_PATH = path.join(__dirname, '..', 'cli.mjs');
const REPO_ROOT = path.resolve(__dirname, '..', '..');
const MAX_BODY = 64 * 1024;

function send(res, code, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(code, { 'content-type': 'application/json', 'cache-control': 'no-store' });
  res.end(body);
}

function sendFile(res, file, type) {
  if (!existsSync(file)) { res.writeHead(404); res.end('not found'); return; }
  res.writeHead(200, { 'content-type': type, 'cache-control': 'no-store' });
  res.end(readFileSync(file));
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let n = 0; const chunks = [];
    req.on('data', (c) => { n += c.length; if (n > MAX_BODY) { reject(new Error('body too large')); req.destroy(); } else chunks.push(c); });
    req.on('end', () => { try { resolve(chunks.length ? JSON.parse(Buffer.concat(chunks).toString('utf8')) : {}); } catch (e) { reject(e); } });
    req.on('error', reject);
  });
}

// Resolve the explicit ?ws / body.ws workspace, or throw (→ caller returns 400). No silent default for
// state-changing actions: a UI must pick a workspace first.
function requireWorkspace(id) {
  if (!id) { const e = new Error('missing workspace id (?ws=<id>)'); e.http = 400; throw e; }
  return api.getWorkspace(id); // throws EngineError (unknown id) → mapped to 400 below
}

// The request handler (exported for tests so they can drive it without a real socket if desired).
export async function handleRequest(req, res) {
  const url = new URL(req.url, 'http://127.0.0.1');
  const route = url.pathname;
  const ws = url.searchParams.get('ws');
  try {
    // ── static UI (serves the Vite-built React SPA + its assets) ──
    if (req.method === 'GET' && !route.startsWith('/api/')) {
      const MIME = {
        '.html': 'text/html; charset=utf-8',
        '.js':   'application/javascript; charset=utf-8',
        '.css':  'text/css; charset=utf-8',
        '.svg':  'image/svg+xml',
        '.ico':  'image/x-icon',
        '.png':  'image/png',
        '.woff2': 'font/woff2',
      };
      const candidates = [
        path.join(PUBLIC_DIR, route === '/' ? 'index.html' : route),
        path.join(PUBLIC_DIR, route, 'index.html'),
      ];
      for (const f of candidates) {
        if (!f.startsWith(PUBLIC_DIR)) continue; // path-traversal guard
        if (existsSync(f)) {
          const ext = path.extname(f).toLowerCase();
          return sendFile(res, f, MIME[ext] || 'application/octet-stream');
        }
      }
      // SPA fallback for client-side routes
      const idx = path.join(PUBLIC_DIR, 'index.html');
      if (existsSync(idx)) return sendFile(res, idx, 'text/html; charset=utf-8');
    }
    // ── health ──
    if (req.method === 'GET' && route === '/api/health') {
      return send(res, 200, { ok: true, version: readVersion(), at: new Date().toISOString() });
    }
    // ── workspace picker ──
    if (req.method === 'GET' && route === '/api/workspaces') {
      return send(res, 200, api.getWorkspaces());
    }
    // ── read queries (workspace-scoped) ──
    if (req.method === 'GET' && route === '/api/status') {
      return send(res, 200, await api.getStatus(requireWorkspace(ws)));
    }
    if (req.method === 'GET' && route === '/api/queues') {
      return send(res, 200, await api.getQueues(requireWorkspace(ws)));
    }
    if (req.method === 'GET' && route === '/api/budget') {
      return send(res, 200, await api.getBudget(requireWorkspace(ws)));
    }
    if (req.method === 'GET' && route === '/api/usage') {
      return send(res, 200, await api.getUsage(requireWorkspace(ws)));
    }
    if (req.method === 'GET' && route === '/api/decisions') {
      const n = Math.max(1, Math.min(200, Number(url.searchParams.get('n')) || 40));
      const cy = url.searchParams.get('cycle');
      return send(res, 200, await api.getDecisions(requireWorkspace(ws), { n, cycle: cy != null ? Number(cy) : null }));
    }
    if (req.method === 'GET' && route === '/api/activity') {
      const n = Math.max(1, Math.min(200, Number(url.searchParams.get('n')) || 20));
      return send(res, 200, await api.getActivity(requireWorkspace(ws), n));
    }
    if (req.method === 'GET' && route === '/api/stats') {
      const b = await api.getBudget(requireWorkspace(ws));
      const remaining = b.quota && isFinite(b.quota) ? Math.max(0, b.quota - b.spent) : null;
      return send(res, 200, {
        totalBudget: b.quota,
        spent: b.spent,
        remaining,
        costPerCycle: b.usage.cycles > 0 ? b.usage.costUsd / b.usage.cycles : 0,
        inputTokens: b.usage.inputTokens,
        outputTokens: b.usage.outputTokens,
      });
    }
    if (req.method === 'GET' && route === '/api/stats/cost') {
      return send(res, 200, await api.getCostAnalytics(requireWorkspace(ws)));
    }
    // U-66: expose per-cycle intent/plan validation flags (intent_locked, plan_validated, validation_feedback).
    if (req.method === 'GET' && route === '/api/cycle/state') {
      return send(res, 200, await api.getCycleState(requireWorkspace(ws)));
    }
    if (req.method === 'GET' && route === '/api/history') {
      const n = Math.max(1, Math.min(200, Number(url.searchParams.get('n')) || 50));
      const activity = await api.getActivity(requireWorkspace(ws), n);
      return send(res, 200, activity.history || []);
    }
    if (req.method === 'GET' && route === '/api/logs') {
      const n = Math.max(1, Math.min(100, Number(url.searchParams.get('n')) || 25));
      const logFile = path.join(__dirname, '..', 'run.log');
      if (!existsSync(logFile)) return send(res, 200, { lines: [] });
      try {
        const content = readFileSync(logFile, 'utf8');
        const lines = content.split('\n').filter(l => l.trim()).slice(-n);
        return send(res, 200, { lines });
      } catch { return send(res, 200, { lines: [] }); }
    }
    if (req.method === 'GET' && route === '/api/keys') {
      const w = requireWorkspace(ws);
      let pools = [];
      try { const c = JSON.parse(readFileSync(path.join(w.root, 'config.json'), 'utf8')); pools = c.api_pools || []; } catch { /* config absent or has no api_pools yet */ }
      return send(res, 200, { workspace: w.id, pools });
    }
    // ── control actions (POST {ws,...}) ──
    if (req.method === 'POST') {
      const body = await readBody(req);
      const w = requireWorkspace(body.ws || ws);
      if (route === '/api/task') {
        const out = await api.addTask(w, body.text, body.stampMs);
        return send(res, 200, out);
      }
      if (route === '/api/task/delete') { return send(res, 200, await api.deleteTask(w, body.taskId)); }
      if (route === '/api/task/retry')  { return send(res, 200, await api.retryTask(w, body.taskId)); }
      if (route === '/api/task/bump')   { return send(res, 200, await api.bumpTask(w, body.taskId)); }
      if (route === '/api/stop') { return send(res, 200, api.requestStop(w, body.reason)); }
      if (route === '/api/resume') { return send(res, 200, api.clearStop(w)); }
      if (route === '/api/calibrate') {
        const out = await api.calibrateUsage(w, {
          pctUsed: body.pctUsed != null ? Number(body.pctUsed) : undefined,
          quota: body.quota != null ? Number(body.quota) : undefined,
          spentTokens: body.spentTokens != null ? Number(body.spentTokens) : undefined,
          actualQuota: body.actualQuota != null ? Number(body.actualQuota) : undefined,
          tier: body.tier != null ? String(body.tier) : undefined,
          resetInMinutes: body.resetInMinutes != null ? Number(body.resetInMinutes) : undefined,
        });
        return send(res, 200, out);
      }
      if (route === '/api/start') {
        // Use `start` (not `run`): clears the STOP flag + launches the watchdog so the supervisor
        // auto-restarts on crash. `run` starts the supervisor directly with no watchdog — after
        // /api/stop the watchdog has also exited, so a bare `run` leaves the engine unguarded.
        const child = spawn(process.execPath, [CLI_PATH, '--workspace', w.id, 'start'],
          { cwd: REPO_ROOT, detached: true, stdio: 'ignore' });
        child.unref();
        return send(res, 200, { workspace: w.id, started: true, pid: child.pid });
      }
    }
    res.writeHead(404, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ error: 'not found', route }));
  } catch (e) {
    const code = e.http || (e.code === 'WORKSPACE_UNKNOWN' ? 400 : 500);
    send(res, code, { error: e.message, code: e.code || null });
  }
}

export function createControlServer() {
  return http.createServer((req, res) => { handleRequest(req, res); });
}

/** Start the server bound to 127.0.0.1 (loopback only). Returns { server, url }. */
export function startControlServer({ port = 3000, host = '127.0.0.1' } = {}) {
  const server = createControlServer();
  return new Promise((resolve) => {
    server.listen(port, host, () => {
      const a = server.address();
      resolve({ server, url: `http://${host}:${a.port}`, port: a.port });
    });
  });
}

// CLI entry: `node autopilot/ui/server.mjs [port]`
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const port = Number(process.argv[2]) || 3000;
  startControlServer({ port }).then(({ url }) => {
    console.log(`[kinetic] control center → ${url}  (loopback only; Ctrl+C to stop)`);
  });
}
