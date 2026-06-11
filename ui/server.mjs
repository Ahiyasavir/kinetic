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
    // ── static UI ──
    if (req.method === 'GET' && (route === '/' || route === '/index.html')) {
      return sendFile(res, path.join(PUBLIC_DIR, 'index.html'), 'text/html; charset=utf-8');
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
    if (req.method === 'GET' && route === '/api/activity') {
      const n = Math.max(1, Math.min(200, Number(url.searchParams.get('n')) || 20));
      return send(res, 200, await api.getActivity(requireWorkspace(ws), n));
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
      if (route === '/api/stop') { return send(res, 200, api.requestStop(w, body.reason)); }
      if (route === '/api/resume') { return send(res, 200, api.clearStop(w)); }
      if (route === '/api/start') {
        // The ONLY side-effecting spawn: launch the loop for this workspace (detached). Opt-in.
        const child = spawn(process.execPath, [CLI_PATH, '--workspace', w.id, 'run'],
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
export function startControlServer({ port = 4317, host = '127.0.0.1' } = {}) {
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
  const port = Number(process.argv[2]) || 4317;
  startControlServer({ port }).then(({ url }) => {
    console.log(`[kinetic] control center → ${url}  (loopback only; Ctrl+C to stop)`);
  });
}
