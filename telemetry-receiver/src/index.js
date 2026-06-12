const DASHBOARD_SECRET = typeof KINETIC_DASHBOARD_SECRET !== 'undefined' ? KINETIC_DASHBOARD_SECRET : null;

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    if (request.method === 'POST' && url.pathname === '/ingest') {
      return handleIngest(request, env);
    }
    if (request.method === 'GET' && url.pathname === '/stats') {
      return handleStats(request, env);
    }
    if (request.method === 'GET' && url.pathname === '/health') {
      return Response.json({ ok: true, ts: new Date().toISOString() });
    }
    return new Response('not found', { status: 404 });
  }
};

async function handleIngest(request, env) {
  let body;
  try { body = await request.json(); } catch {
    return new Response('bad json', { status: 400 });
  }

  const events = Array.isArray(body.events) ? body.events : [];
  const projectId = sanitize(body.projectId || body.source || 'unknown');
  const now = Date.now();

  for (const ev of events) {
    if (ev.type !== 'cycle-summary') continue;
    const d = ev.data || {};

    const record = {
      ts: ev.ts || new Date().toISOString(),
      cycle: d.cycle ?? null,
      outcome: d.outcome ?? null,
      taskGoal: d.taskGoal ?? null,
      taskRisk: d.taskRisk ?? null,
      taskClass: d.taskClass ?? null,
      modelTier: d.modelTier ?? null,
      blockReason: d.blockReason ?? null,
      durationMs: d.durationMs ?? null,
      costUsd: d.costUsd ?? null,
      revisionCount: d.revisionCount ?? null,
      validationPassed: d.validationPassed ?? null,
      projectId,
    };

    const dayKey = `cycles:${projectId}:${dayOf(ev.ts)}`;
    const existing = await env.KINETIC_KV.get(dayKey, 'json') || [];
    existing.push(record);
    if (existing.length > 500) existing.splice(0, existing.length - 500);
    await env.KINETIC_KV.put(dayKey, JSON.stringify(existing), { expirationTtl: 60 * 60 * 24 * 90 });

    await updateProjectStats(env, projectId, record, now);
    await updateGlobalStats(env, record, now);
  }

  return Response.json({ ok: true, ingested: events.filter(e => e.type === 'cycle-summary').length });
}

async function updateProjectStats(env, projectId, record, now) {
  const key = `stats:project:${projectId}`;
  const stats = await env.KINETIC_KV.get(key, 'json') || emptyStats(projectId);
  applyRecord(stats, record, now);
  await env.KINETIC_KV.put(key, JSON.stringify(stats));
}

async function updateGlobalStats(env, record, now) {
  const key = 'stats:global';
  const stats = await env.KINETIC_KV.get(key, 'json') || emptyStats('global');
  applyRecord(stats, record, now);
  const projects = new Set(stats.projects || []);
  projects.add(record.projectId);
  stats.projects = [...projects];
  await env.KINETIC_KV.put(key, JSON.stringify(stats));
}

function applyRecord(stats, r, now) {
  stats.totalCycles = (stats.totalCycles || 0) + 1;
  stats.lastSeenAt = new Date(now).toISOString();
  if (r.outcome === 'merged') stats.merged = (stats.merged || 0) + 1;
  if (r.outcome && r.outcome.startsWith('blocked')) stats.blocked = (stats.blocked || 0) + 1;
  if (r.outcome && r.outcome.startsWith('re-queued')) stats.requeued = (stats.requeued || 0) + 1;
  if (r.costUsd != null) {
    stats.totalCostUsd = (stats.totalCostUsd || 0) + r.costUsd;
    stats.costSamples = (stats.costSamples || 0) + 1;
  }
  if (r.durationMs != null) {
    stats.totalDurationMs = (stats.totalDurationMs || 0) + r.durationMs;
    stats.durationSamples = (stats.durationSamples || 0) + 1;
  }
  if (r.blockReason) {
    stats.blockReasons = stats.blockReasons || {};
    const short = r.blockReason.substring(0, 80);
    stats.blockReasons[short] = (stats.blockReasons[short] || 0) + 1;
  }
  if (r.taskGoal) {
    stats.byGoal = stats.byGoal || {};
    stats.byGoal[r.taskGoal] = stats.byGoal[r.taskGoal] || { total: 0, merged: 0 };
    stats.byGoal[r.taskGoal].total++;
    if (r.outcome === 'merged') stats.byGoal[r.taskGoal].merged++;
  }
  if (r.modelTier) {
    stats.byTier = stats.byTier || {};
    stats.byTier[r.modelTier] = (stats.byTier[r.modelTier] || 0) + 1;
  }
  stats.mergeRate = stats.merged && stats.totalCycles ? (stats.merged / stats.totalCycles) : 0;
  stats.avgCostUsd = stats.costSamples ? stats.totalCostUsd / stats.costSamples : null;
  stats.avgDurationMs = stats.durationSamples ? stats.totalDurationMs / stats.durationSamples : null;
}

async function handleStats(request, env) {
  const url = new URL(request.url);
  const secret = url.searchParams.get('key');
  if (DASHBOARD_SECRET && secret !== DASHBOARD_SECRET) {
    return new Response('unauthorized', { status: 401 });
  }

  const projectId = url.searchParams.get('project');
  if (projectId) {
    const stats = await env.KINETIC_KV.get(`stats:project:${sanitize(projectId)}`, 'json');
    return Response.json(stats || { error: 'project not found' });
  }

  const global = await env.KINETIC_KV.get('stats:global', 'json') || emptyStats('global');
  return Response.json(global);
}

function emptyStats(id) {
  return {
    id, totalCycles: 0, merged: 0, blocked: 0, requeued: 0,
    mergeRate: 0, totalCostUsd: 0, costSamples: 0, avgCostUsd: null,
    totalDurationMs: 0, durationSamples: 0, avgDurationMs: null,
    byGoal: {}, byTier: {}, blockReasons: {}, projects: [],
    lastSeenAt: null
  };
}

function dayOf(ts) {
  try { return new Date(ts).toISOString().slice(0, 10); } catch { return 'unknown'; }
}

function sanitize(s) {
  return String(s || '').replace(/[^a-z0-9_-]/gi, '-').slice(0, 64).toLowerCase();
}
