// control-server.mjs — assertions for the local control server (ui/server.mjs): the engine↔UI API
// boundary. Verifies health/workspaces/status routes, the explicit-workspace guard (unknown id → 400),
// static UI serving, 404s, and that it binds LOOPBACK ONLY. It deliberately does NOT POST stop/start to
// the live default workspace (that would touch real state); POST coverage is limited to the 400 guards.
//   node autopilot/tests/control-server.mjs
import assert from 'node:assert/strict';
import { startControlServer } from '../ui/server.mjs';

let passed = 0;
const acheck = async (name, fn) => { await fn(); passed++; console.log(`  ✓ ${name}`); };

const { server, url } = await startControlServer({ port: 0 }); // ephemeral port, 127.0.0.1
const j = async (p, opts) => { const r = await fetch(url + p, opts); return { code: r.status, body: await r.json().catch(() => null), ct: r.headers.get('content-type') }; };

try {
  await acheck('binds loopback only (127.0.0.1)', () => {
    assert.equal(server.address().address, '127.0.0.1', 'never exposed to the network');
  });

  await acheck('GET /api/health → ok + version', async () => {
    const r = await j('/api/health');
    assert.equal(r.code, 200);
    assert.equal(r.body.ok, true);
    assert.ok(typeof r.body.version === 'string');
  });

  let defaultId = null;
  await acheck('GET /api/workspaces → picker list incl. default', async () => {
    const r = await j('/api/workspaces');
    assert.equal(r.code, 200);
    assert.ok(Array.isArray(r.body.workspaces) && r.body.workspaces.length >= 1);
    defaultId = r.body.defaultId;
    assert.ok(r.body.workspaces.some((w) => w.id === defaultId), 'default present');
  });

  await acheck('GET /api/status?ws=<default> → workspace-scoped status', async () => {
    const r = await j('/api/status?ws=' + encodeURIComponent(defaultId));
    assert.equal(r.code, 200);
    assert.equal(r.body.workspace.id, defaultId);
    assert.ok(typeof r.body.quotaMode === 'string');
  });

  await acheck('GET /api/status with NO workspace → 400 (explicit selection required)', async () => {
    const r = await j('/api/status');
    assert.equal(r.code, 400);
    assert.ok(/workspace/i.test(r.body.error));
  });

  await acheck('GET /api/status?ws=bogus → 400 (no silent fallback)', async () => {
    const r = await j('/api/status?ws=definitely-not-a-workspace');
    assert.equal(r.code, 400);
    assert.equal(r.body.code, 'WORKSPACE_UNKNOWN');
  });

  await acheck('GET /api/stats/cost?ws=<default> → cost-analytics payload shape', async () => {
    const r = await j('/api/stats/cost?ws=' + encodeURIComponent(defaultId));
    assert.equal(r.code, 200);
    assert.equal(r.body.workspace, defaultId);
    for (const k of ['byGoal', 'byRisk']) assert.ok(r.body[k] && typeof r.body[k] === 'object', `${k} present`);
    for (const k of ['totalCycles', 'avgCostPerCycle', 'projectedWeeklySpend', 'variance']) {
      assert.equal(typeof r.body[k], 'number', `${k} numeric`);
      assert.ok(r.body[k] >= 0, `${k} non-negative`);
    }
  });

  await acheck('GET /api/stats/cost with NO workspace → 400 (explicit selection required)', async () => {
    const r = await j('/api/stats/cost');
    assert.equal(r.code, 400);
    assert.ok(/workspace/i.test(r.body.error));
  });

  await acheck('GET / serves the static control center', async () => {
    const r = await fetch(url + '/');
    assert.equal(r.status, 200);
    assert.ok((r.headers.get('content-type') || '').includes('text/html'));
    const html = await r.text();
    // The served static document is ui/public/index.html (title "Autopilot Dashboard"); the React app
    // renders the "Control Center" heading client-side, so assert on the static title that is actually present.
    assert.ok(/Autopilot Dashboard/.test(html), 'the UI document');
  });

  await acheck('unknown route → 404', async () => {
    const r = await j('/api/nope');
    assert.equal(r.code, 404);
  });

  await acheck('POST /api/task with unknown workspace → 400 (guard, no live-state mutation)', async () => {
    const r = await j('/api/task', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ ws: 'bogus-ws', text: 'x' }) });
    assert.equal(r.code, 400);
  });

  await acheck('POST /api/stop with NO workspace → 400', async () => {
    const r = await j('/api/stop', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({}) });
    assert.equal(r.code, 400);
  });
} finally {
  server.close();
}

console.log(`\ncontrol-server: ${passed}/${passed} checks passed ✓`);
