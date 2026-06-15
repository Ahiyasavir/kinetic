import React, { useCallback, useEffect, useRef, useState, useMemo } from 'react';

// ════════════════════════════════════════════════════════════════════════════
//  Kinetic Control Center — a desktop-first dashboard over the local control API
//  (ui/server.mjs). Polls live engine state and exposes the safe control actions.
// ════════════════════════════════════════════════════════════════════════════

// ── i18n ────────────────────────────────────────────────────────────────────
const LANG_KEY = 'kinetic-ui-language';
type Lang = 'EN' | 'HE';

const STRINGS = {
  EN: {
    brand: 'Kinetic', subtitle: 'Autonomous Engine',
    workspace: 'Workspace', status: 'Status', controls: 'Controls',
    start: 'Start', pause: 'Pause', resume: 'Resume',
    overview: 'Overview', cycle: 'Cycle', phase: 'Phase',
    governor: 'Budget Governor', breaker: 'Circuit Breaker', rateLimit: 'Rate Limit',
    armed: 'Armed', tripped: 'Tripped', paused: 'Paused', running: 'Running', stopped: 'Stopped', idle: 'Idle',
    sevenDay: '7-Day Quota', fiveHour: '5-Hour Window',
    spent: 'Spent', quota: 'Quota', cyclesLeft: 'Cycles left', cost: 'Cost',
    resetsIn: 'Resets in', noPressure: 'No pressure', clear: 'Clear',
    queues: 'Queues', backlog: 'Backlog', done: 'Done', blocked: 'Blocked',
    history: 'Cycle History', time: 'Time', outcome: 'Outcome', task: 'Task', dur: 'Duration', model: 'Model',
    submitTitle: 'Submit a Task', submitPh: 'Describe a task for the engine…', submitBtn: 'Add to queue',
    submitHint: 'Lands in this workspace’s inbox as a high-priority user task.',
    noData: 'No data yet — start the engine.', loading: 'Loading…', live: 'Live', offline: 'Offline',
    connecting: 'Connecting…', tokens: 'tokens', inOut: 'in / out', cache: 'cache',
    submitted: 'Task added ✓', confirmPause: 'Pause the engine after the current cycle?',
    confirmDelete: 'Delete this task permanently?', deleted: 'Task deleted ✓', retried: 'Re-queued ✓', bumped: 'Moved to top ✓',
    del: 'Delete', retry: 'Retry', bump: 'Move to top', blockedTitle: 'Blocked tasks', noBlocked: 'Nothing blocked',
    decisionTitle: 'Decision', why: 'Why chosen', whyBeat: 'Why it won', live2: 'What is now live', diff: 'File-level diff',
    notes: 'Notes', validation: 'Validation', verdict: 'Review verdict', impl: 'Implementer', noEntry: 'No decision-log entry for this cycle.',
    clickRow: 'Click a row to see why it was chosen.', close: 'Close',
    logTitle: 'Live Log', noLogs: 'No logs yet — start the engine.', currentTask: 'Current Task',
    ratePaused: 'Rate limited — resuming in', noCurrent: 'Idle',
    calibrate: 'Calibrate', calibrateTitle: 'Calibrate Budget', calibrateHint: "Enter the % shown on Claude's usage page. The engine will adjust for your own interactive sessions that aren't tracked here.",
    calibratePct: 'Actual % used (from Claude)', calibrateQuota: 'Quota tokens (optional)', calibrateApply: 'Apply calibration',
    calibrateDone: 'Calibrated ✓', calibrateErr: 'Calibration failed',
  },
  HE: {
    brand: 'קינטיק', subtitle: 'מנוע אוטונומי',
    workspace: 'סביבה', status: 'מצב', controls: 'בקרות',
    start: 'הפעל', pause: 'השהה', resume: 'המשך',
    overview: 'סקירה', cycle: 'מחזור', phase: 'שלב',
    governor: 'בקר תקציב', breaker: 'מפסק', rateLimit: 'מגבלת קצב',
    armed: 'דרוך', tripped: 'נותק', paused: 'מושהה', running: 'פעיל', stopped: 'נעצר', idle: 'ממתין',
    sevenDay: 'מכסת 7 ימים', fiveHour: 'חלון 5 שעות',
    spent: 'נוצל', quota: 'מכסה', cyclesLeft: 'מחזורים נותרו', cost: 'עלות',
    resetsIn: 'מתאפס בעוד', noPressure: 'אין עומס', clear: 'פנוי',
    queues: 'תורים', backlog: 'בצבר', done: 'הושלם', blocked: 'חסום',
    history: 'היסטוריית מחזורים', time: 'שעה', outcome: 'תוצאה', task: 'משימה', dur: 'משך', model: 'מודל',
    submitTitle: 'הגשת משימה', submitPh: 'תאר משימה למנוע…', submitBtn: 'הוסף לתור',
    submitHint: 'נכנס ל-inbox של הסביבה כמשימת משתמש בעדיפות גבוהה.',
    noData: 'אין נתונים — הפעל את המנוע.', loading: 'טוען…', live: 'חי', offline: 'מנותק',
    connecting: 'מתחבר…', tokens: 'טוקנים', inOut: 'נכנס / יוצא', cache: 'מטמון',
    submitted: 'המשימה נוספה ✓', confirmPause: 'להשהות את המנוע אחרי המחזור הנוכחי?',
    confirmDelete: 'למחוק את המשימה לצמיתות?', deleted: 'נמחק ✓', retried: 'הוחזר לתור ✓', bumped: 'הועלה לראש ✓',
    del: 'מחק', retry: 'נסה שוב', bump: 'העבר לראש', blockedTitle: 'משימות חסומות', noBlocked: 'אין חסומות',
    decisionTitle: 'החלטה', why: 'למה נבחר', whyBeat: 'למה ניצח', live2: 'מה עלה לאוויר', diff: 'שינויי קבצים',
    notes: 'הערות', validation: 'אימות', verdict: 'פסיקת סקירה', impl: 'מיישם', noEntry: 'אין רשומת החלטה למחזור זה.',
    clickRow: 'לחץ על שורה כדי לראות למה נבחרה.', close: 'סגור',
    logTitle: 'לוג חי', noLogs: 'אין לוג עדיין — הפעל את המנוע.', currentTask: 'משימה נוכחית',
    ratePaused: 'מגבלת קצב — ממשיך בעוד', noCurrent: 'ממתין',
    calibrate: 'כיוון', calibrateTitle: 'כיוון תקציב', calibrateHint: 'הזן את האחוז שמוצג בדף השימוש של Claude. המנוע יתאים את עצמו לסשנים האינטראקטיביים שלך שלא נספרים כאן.',
    calibratePct: '% בפועל (מ-Claude)', calibrateQuota: 'טוקנים בסה"כ (אופציונלי)', calibrateApply: 'החל כיוון',
    calibrateDone: 'כויון ✓', calibrateErr: 'כיוון נכשל',
  },
} as const;

// ── types ───────────────────────────────────────────────────────────────────
interface WorkspaceInfo { id: string; label: string; }
interface TaskRow { id: string; title?: string; goal?: string; risk?: number | null; status?: string | null; userRequested?: boolean; blockReason?: string | null; }
interface QueueState { backlog: TaskRow[]; done: TaskRow[]; blocked: TaskRow[]; exists: boolean; }
interface StatusState {
  exists: boolean; stopRequested: boolean; status?: string | null; cycle?: number; goalPhase?: string | null;
  queues?: { backlog: number; done: number; blocked: number };
  budget?: { action: string; reason: string; spent: number; quota: number; fractionUsed: number; cyclesLeft: number | null; safeMode?: boolean; quotaMode?: string };
  breaker?: { tripped: boolean; reason: string | null };
}
interface BudgetState {
  spent: number; quota: number; fractionUsed: number; cyclesLeft: number | null;
  usage: { cycles: number; costUsd: number; inputTokens: number; outputTokens: number; cacheReadTokens?: number; cacheCreationTokens?: number };
}
interface UsageState {
  status?: string | null;
  sevenDay: { spent: number; quota: number; fractionUsed: number; cyclesLeft: number | null; resetAt: string | null; action: string };
  fiveHour: { spent: number; entries: number; resetAt: number; msLeft: number };
  rateLimit: { paused: boolean; pausedUntil: string | null; msLeft: number; consecutiveHits: number };
  calibration?: { calibratedAt: string; calibratedPct: number | null; externalOffset: number } | null;
}
interface HistEntry { cycle?: number; ts?: string; outcome?: string; taskId?: string; title?: string; durationMs?: number | null; model?: string; modelTier?: string; revisions?: number; }
interface DecisionFull { cycle: number; ts: string; task: string; title: string; goal: string; outcome: string; fields: Record<string, string>; raw: string; }

// ── helpers ─────────────────────────────────────────────────────────────────
function k(n: number | null | undefined): string {
  if (n == null || !isFinite(n as number)) return '∞';
  const v = n as number;
  if (Math.abs(v) >= 1e9) return (v / 1e9).toFixed(2) + 'B';
  if (Math.abs(v) >= 1e6) return (v / 1e6).toFixed(1) + 'M';
  if (Math.abs(v) >= 1e3) return Math.round(v / 1e3) + 'k';
  return String(v);
}
function fmtMs(d?: number | null): string {
  if (!d) return '—';
  if (d >= 3600000) return (d / 3600000).toFixed(1) + 'h';
  if (d >= 60000) return (d / 60000).toFixed(1) + 'm';
  return Math.round(d / 1000) + 's';
}
function fmtCountdown(ms: number): string {
  if (ms <= 0) return '0s';
  const h = Math.floor(ms / 3600000); const m = Math.floor((ms % 3600000) / 60000); const s = Math.floor((ms % 60000) / 1000);
  if (h > 0) return `${h}h ${m}m`;
  if (m > 0) return `${m}m ${s}s`;
  return `${s}s`;
}
function outcomeCls(o?: string): string {
  const s = String(o || '').toLowerCase();
  if (s.includes('merg') || s.includes('approv') || s.includes('pass') || s === 'done') return 'ok';
  if (s.includes('reject') || s.includes('fail') || s.includes('block')) return 'bad';
  if (s.includes('skip') || s.includes('bypass') || s.includes('re-queue') || s.includes('requeue')) return 'warn';
  return 'other';
}
function modelShort(h: HistEntry): string {
  const m = h.model || h.modelTier || '';
  if (/opus/i.test(m)) return 'Opus';
  if (/sonnet/i.test(m)) return 'Sonnet';
  if (/haiku/i.test(m)) return 'Haiku';
  if (/fable/i.test(m)) return 'Fable';
  return m || '—';
}

// Live engine state → a status descriptor (pill class + label key).
function deriveRun(status: StatusState | null, usage: UsageState | null): { cls: string; key: keyof typeof STRINGS['EN'] } {
  if (status?.breaker?.tripped) return { cls: 'bad', key: 'tripped' };
  if (usage?.rateLimit?.paused) return { cls: 'warn', key: 'paused' };
  const s = String(status?.status || '').toLowerCase();
  if (status?.stopRequested || s.includes('stop')) return { cls: 'idle', key: 'stopped' };
  if (s.includes('pause')) return { cls: 'warn', key: 'paused' };
  if (s.includes('run')) return { cls: 'ok', key: 'running' };
  if (!status?.exists) return { cls: 'idle', key: 'idle' };
  return { cls: 'ok', key: 'running' };
}

// ── component ───────────────────────────────────────────────────────────────
export default function App(): JSX.Element {
  const [lang, setLang] = useState<Lang>(() => { try { return (localStorage.getItem(LANG_KEY) as Lang) || 'EN'; } catch { return 'EN'; } });
  const t = STRINGS[lang];
  const isHE = lang === 'HE';

  const [wsId, setWsId] = useState('');
  const [workspaces, setWorkspaces] = useState<WorkspaceInfo[]>([]);
  const [status, setStatus] = useState<StatusState | null>(null);
  const [queue, setQueue] = useState<QueueState | null>(null);
  const [budget, setBudget] = useState<BudgetState | null>(null);
  const [usage, setUsage] = useState<UsageState | null>(null);
  const [history, setHistory] = useState<HistEntry[]>([]);
  const [conn, setConn] = useState<'connecting' | 'live' | 'offline'>('connecting');
  const [lastAt, setLastAt] = useState('');
  const [taskText, setTaskText] = useState('');
  const [toast, setToast] = useState('');
  const [busy, setBusy] = useState(false);
  const [actioning, setActioning] = useState('');         // task id currently being mutated
  const [decision, setDecision] = useState<DecisionFull | null>(null); // open decision drawer
  const [decisionLoading, setDecisionLoading] = useState(false);
  const [logs, setLogs] = useState<string[]>([]);
  const [showCalibrate, setShowCalibrate] = useState(false);
  const [calibPct, setCalibPct] = useState('');
  const [calibQuota, setCalibQuota] = useState('');
  const timerRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const logTailRef = useRef<HTMLDivElement>(null);

  function toggleLang() {
    const next: Lang = lang === 'EN' ? 'HE' : 'EN';
    try { localStorage.setItem(LANG_KEY, next); } catch { /* ignore */ }
    document.documentElement.dir = next === 'HE' ? 'rtl' : 'ltr';
    setLang(next);
  }
  function flash(msg: string) { setToast(msg); window.setTimeout(() => setToast(''), 2600); }

  // Load workspaces once
  useEffect(() => {
    document.documentElement.dir = isHE ? 'rtl' : 'ltr';
    fetch('/api/workspaces').then(r => r.json())
      .then((d: { workspaces?: Array<{ id: string; label?: string }>; defaultId?: string }) => {
        const ws: WorkspaceInfo[] = (d.workspaces || []).map(w => ({ id: w.id, label: w.label || w.id }));
        setWorkspaces(ws);
        setWsId(d.defaultId || ws[0]?.id || '');
      })
      .catch(() => setConn('offline'));
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  const poll = useCallback(async () => {
    if (!wsId) return;
    // Fetch a JSON endpoint, returning null on any non-2xx (e.g. a route 404 on an older server) so a
    // single bad endpoint can never blank the dashboard — each card degrades independently.
    const getJson = async (path: string) => {
      try { const r = await fetch(path); return r.ok ? await r.json() : null; } catch { return null; }
    };
    const enc = encodeURIComponent(wsId);
    const [sData, qData, bData, uData, aData, lData] = await Promise.all([
      getJson(`/api/status?ws=${enc}`),
      getJson(`/api/queues?ws=${enc}`),
      getJson(`/api/budget?ws=${enc}`),
      getJson(`/api/usage?ws=${enc}`),
      getJson(`/api/activity?ws=${enc}&n=60`),
      getJson(`/api/logs?n=20`),
    ]);
    if (sData) setStatus(sData as StatusState);
    if (qData) setQueue(qData as QueueState);
    if (bData) setBudget(bData as BudgetState);
    if (uData) setUsage(uData as UsageState);
    if (aData) setHistory((aData as { history?: HistEntry[] }).history || []);
    if (lData) setLogs((lData as { lines?: string[] }).lines || []);
    setLastAt(new Date().toLocaleTimeString([], { hour12: false }));
    // Live if at least the core status endpoint answered; offline only if everything failed.
    setConn(sData || qData || bData ? 'live' : 'offline');
  }, [wsId]);

  useEffect(() => {
    if (!wsId) return;
    if (timerRef.current) clearInterval(timerRef.current);
    poll();
    timerRef.current = setInterval(poll, 5000);
    return () => { if (timerRef.current) clearInterval(timerRef.current); };
  }, [wsId, poll]);

  // Auto-scroll log tail to bottom when new lines arrive
  useEffect(() => {
    if (logTailRef.current) logTailRef.current.scrollTop = logTailRef.current.scrollHeight;
  }, [logs]);

  // Control actions
  async function act(path: string, body: Record<string, unknown> = {}) {
    if (!wsId) return;
    setBusy(true);
    try {
      await fetch(path, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ ws: wsId, ...body }) });
      await poll();
    } catch { /* surfaced via conn */ } finally { setBusy(false); }
  }
  async function onStart() { await act('/api/start'); flash((status?.exists ? t.resume : t.start) + ' ✓'); }
  async function onPause() { if (!window.confirm(t.confirmPause)) return; await act('/api/stop'); flash(t.pause + ' ✓'); }
  async function onCalibrate(e: React.FormEvent) {
    e.preventDefault();
    const pct = parseFloat(calibPct);
    if (isNaN(pct) || pct <= 0 || pct > 100) { flash(t.calibrateErr + ': % must be 1–100'); return; }
    setBusy(true);
    try {
      const body: Record<string, unknown> = { ws: wsId, pctUsed: pct };
      if (calibQuota.trim()) body.quota = Math.round(parseFloat(calibQuota.replace(/[,_]/g, '')));
      const r = await fetch('/api/calibrate', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
      if (!r.ok) { const d = await r.json().catch(() => ({})); flash(t.calibrateErr + ': ' + (d.error || r.status)); }
      else { flash(t.calibrateDone); setShowCalibrate(false); setCalibPct(''); setCalibQuota(''); await poll(); }
    } catch { flash(t.calibrateErr); } finally { setBusy(false); }
  }

  async function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    const text = taskText.trim(); if (!text) return;
    await act('/api/task', { text });
    setTaskText(''); flash(t.submitted);
  }

  // Task management ops (delete / retry / bump) — optimistic: mark the row busy, POST, re-poll.
  async function taskOp(path: string, taskId: string, okMsg: string) {
    if (!wsId) return;
    setActioning(taskId);
    try {
      await fetch(path, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ ws: wsId, taskId }) });
      await poll();
      flash(okMsg);
    } catch { /* surfaced via conn */ } finally { setActioning(''); }
  }
  function onDelete(id: string, label: string) {
    if (!window.confirm(`${t.confirmDelete}\n\n${label}`)) return;
    taskOp('/api/task/delete', id, t.deleted);
  }
  function onRetry(id: string) { taskOp('/api/task/retry', id, t.retried); }
  function onBump(id: string) { taskOp('/api/task/bump', id, t.bumped); }

  // Decision drawer — fetch one cycle's full parsed decision_log entry.
  async function openDecision(cycle?: number) {
    if (cycle == null || !wsId) return;
    setDecisionLoading(true);
    setDecision({ cycle, ts: '', task: '', title: '', goal: '', outcome: '', fields: {}, raw: '' });
    try {
      const r = await fetch(`/api/decisions?ws=${encodeURIComponent(wsId)}&cycle=${cycle}&n=1`);
      const d = await r.json();
      setDecision(d.full || null);
    } catch { setDecision(null); } finally { setDecisionLoading(false); }
  }

  const run = deriveRun(status, usage);
  const pct7 = budget ? Math.min(100, Math.round((budget.fractionUsed ?? 0) * 100)) : 0;
  const bar7 = pct7 >= 90 ? 'var(--bad)' : pct7 >= 70 ? 'var(--warn)' : 'var(--accent)';
  const isStopped = run.key === 'stopped' || run.key === 'idle';
  const isRunning = run.key === 'running';

  const govAction = String(status?.budget?.action || '').toUpperCase();
  const govCls = govAction === 'STOP' ? 'bad' : govAction === 'DOWNGRADE' ? 'warn' : govAction ? 'ok' : 'idle';

  // Current task: latest completed-or-active cycle from history
  const latestEntry = useMemo(() => history.length > 0 ? history[history.length - 1] : null, [history]);
  const currentTaskTitle = isRunning && latestEntry ? (latestEntry.title || latestEntry.taskId || t.noCurrent) : t.noCurrent;

  return (
    <div className={`shell${isHE ? ' rtl' : ''}`}>
      {/* ══ Sidebar (control rail) ══ */}
      <aside className="rail">
        <div className="brand">
          <div className="brand-mark">◇</div>
          <div className="brand-txt">
            <span className="brand-name">{t.brand}</span>
            <span className="brand-sub">{t.subtitle}</span>
          </div>
        </div>

        <div className="rail-block">
          <label className="rail-lbl">{t.workspace}</label>
          <select className="ws-sel" value={wsId} onChange={e => setWsId(e.target.value)}>
            {workspaces.map(w => <option key={w.id} value={w.id}>{w.label}</option>)}
          </select>
        </div>

        <div className="rail-block">
          <label className="rail-lbl">{t.status}</label>
          <div className={`status-pill status-${run.cls}`}>
            <span className="dot" />
            {t[run.key]}
            {status?.cycle != null && <span className="status-cyc">#{status.cycle}</span>}
          </div>
        </div>

        <div className="rail-block">
          <label className="rail-lbl">{t.currentTask}</label>
          <div className="current-task-box" title={currentTaskTitle}>{currentTaskTitle}</div>
        </div>

        <div className="rail-block">
          <label className="rail-lbl">{t.controls}</label>
          <div className="ctrl-row">
            {isStopped
              ? <button className="btn btn-go" disabled={busy} onClick={onStart}>▶ {status?.exists ? t.resume : t.start}</button>
              : <button className="btn btn-stop" disabled={busy} onClick={onPause}>⏸ {t.pause}</button>}
          </div>
        </div>

        <div className="rail-spacer" />

        <div className="rail-foot">
          <div className={`conn conn-${conn}`}>
            <span className="dot" />
            {conn === 'live' ? `${t.live} · ${lastAt}` : conn === 'offline' ? t.offline : t.connecting}
          </div>
          <button className="lang-btn" onClick={toggleLang} title="Toggle language / שנה שפה">
            {lang === 'EN' ? 'עב' : 'EN'}
          </button>
        </div>
      </aside>

      {/* ══ Main ══ */}
      <main className="main">
        {/* Rate-limit banner — shown prominently when the engine is cooling down */}
        {usage?.rateLimit?.paused && (
          <div className="rl-banner">
            <span className="rl-icon">⏳</span>
            <span className="rl-msg">{t.ratePaused} <strong className="rl-countdown">{fmtCountdown(usage.rateLimit.msLeft)}</strong></span>
            {usage.rateLimit.consecutiveHits > 1 && <span className="rl-hits">{usage.rateLimit.consecutiveHits} hits</span>}
          </div>
        )}
        {/* Stat row */}
        <div className="stat-row">
          <div className="stat">
            <span className="stat-lbl">{t.cycle}</span>
            <span className="stat-val">{status?.cycle ?? '—'}</span>
            <span className="stat-sub">{status?.goalPhase || t.phase}</span>
          </div>
          <div className="stat">
            <span className="stat-lbl">{t.governor}</span>
            <span className={`stat-val tone-${govCls}`}>{govAction || '—'}</span>
            <span className="stat-sub clip" title={status?.budget?.reason || ''}>{status?.budget?.reason || ''}</span>
          </div>
          <div className="stat">
            <span className="stat-lbl">{t.breaker}</span>
            <span className={`stat-val tone-${status?.breaker?.tripped ? 'bad' : 'ok'}`}>
              {status?.breaker?.tripped ? t.tripped : t.armed}
            </span>
            <span className="stat-sub clip">{status?.breaker?.reason || ''}</span>
          </div>
          <div className="stat">
            <span className="stat-lbl">{t.rateLimit}</span>
            {usage?.rateLimit?.paused
              ? <><span className="stat-val tone-warn">{t.paused}</span><span className="stat-sub">{t.resetsIn} {fmtCountdown(usage.rateLimit.msLeft)}</span></>
              : <><span className="stat-val tone-ok">{t.clear}</span><span className="stat-sub">{(usage?.rateLimit?.consecutiveHits ?? 0)} hits</span></>}
          </div>
        </div>

        {/* Budget windows */}
        <div className="col-2">
          <section className="card">
            <h2 className="card-h">
              {t.sevenDay}
              <button className="calib-btn" onClick={() => setShowCalibrate(true)} title={t.calibrateTitle}>⊕ {t.calibrate}</button>
            </h2>
            <div className="gauge-top">
              <span className="gauge-pct">{pct7}%</span>
              <span className="mono dim">{k(budget?.spent)} / {k(budget?.quota)} {t.tokens}</span>
            </div>
            <div className="bar-track"><div className="bar-fill" style={{ width: `${pct7}%`, background: bar7 }} /></div>
            <div className="kv-row">
              <div className="kv"><span className="kv-k">{t.cyclesLeft}</span><span className="kv-v mono">{budget?.cyclesLeft == null ? '∞' : budget.cyclesLeft}</span></div>
              <div className="kv"><span className="kv-k">{t.cost}</span><span className="kv-v mono">${(budget?.usage?.costUsd ?? 0).toFixed(2)}</span></div>
            </div>
            {usage?.sevenDay?.resetAt && (
              <div className="window-meter">
                <span className="wm-lbl">{t.resetsIn}</span>
                <span className="wm-val mono">{fmtCountdown(new Date(usage.sevenDay.resetAt).getTime() - Date.now())}</span>
              </div>
            )}
            <div className="token-tags">
              <span className="tag">{t.inOut}: {k(budget?.usage?.inputTokens)} / {k(budget?.usage?.outputTokens)}</span>
              <span className="tag">{t.cache}: {k(budget?.usage?.cacheReadTokens)}</span>
            </div>
            {usage?.calibration && (
              <p className="hint calib-hint">
                ⊕ Calibrated {usage.calibration.calibratedPct != null ? `@ ${usage.calibration.calibratedPct}%` : ''}
                {' '}· +{k(usage.calibration.externalOffset)} external tok
                {' '}· {new Date(usage.calibration.calibratedAt).toLocaleTimeString([], { hour12: false })}
              </p>
            )}
          </section>

          <section className="card">
            <h2 className="card-h">{t.fiveHour}</h2>
            {usage?.fiveHour && usage.fiveHour.entries > 0 ? (
              <>
                <div className="gauge-top">
                  <span className="gauge-pct">{k(usage.fiveHour.spent)}</span>
                  <span className="mono dim">{t.tokens} · {usage.fiveHour.entries} cycles</span>
                </div>
                <div className="window-meter">
                  <span className="wm-lbl">{t.resetsIn}</span>
                  <span className="wm-val mono">{fmtCountdown(usage.fiveHour.msLeft)}</span>
                </div>
                <p className="hint">Self-tracked rolling window (ledger).</p>
              </>
            ) : (usage?.rateLimit?.paused || (usage?.rateLimit?.consecutiveHits ?? 0) > 0) ? (
              <div className="empty-window">
                <span className="big-warn">⚠</span>
                <span className="dim">
                  {t.ratePaused.replace(' —', '')}
                  {(usage?.rateLimit?.consecutiveHits ?? 0) > 1 && ` · ${usage!.rateLimit.consecutiveHits}× hits`}
                </span>
              </div>
            ) : (
              <div className="empty-window">
                <span className="big-ok">✓</span>
                <span className="dim">{t.noPressure}</span>
              </div>
            )}
          </section>
        </div>

        {/* Task submit */}
        <section className="card">
          <h2 className="card-h">{t.submitTitle}</h2>
          <form className="submit-form" onSubmit={onSubmit}>
            <input className="submit-input" value={taskText} onChange={e => setTaskText(e.target.value)} placeholder={t.submitPh} />
            <button className="btn btn-accent" type="submit" disabled={busy || !taskText.trim()}>{t.submitBtn}</button>
          </form>
          <p className="hint">{t.submitHint}</p>
        </section>

        {/* Queues + History */}
        <div className="col-2 stretch">
          <section className="card">
            <h2 className="card-h">{t.queues}</h2>
            <div className="q-row">
              {(['backlog', 'done', 'blocked'] as const).map(key => (
                <div key={key} className={`q-badge q-${key}`}>
                  <span className="q-num">{queue?.[key]?.length ?? status?.queues?.[key] ?? '—'}</span>
                  <span className="q-lbl">{t[key]}</span>
                </div>
              ))}
            </div>
            {queue?.backlog && queue.backlog.length > 0 ? (
              <ul className="task-list">
                {queue.backlog.slice(0, 40).map(task => (
                  <li key={task.id} className={`task-item${actioning === task.id ? ' acting' : ''}`}>
                    {task.userRequested && <span className="star">★</span>}
                    <span className="task-name" title={task.title || task.id}>{task.title || task.id}</span>
                    {task.goal && <span className="tag">{task.goal}</span>}
                    {task.risk != null && <span className="tag risk">r{task.risk}</span>}
                    <span className="row-actions">
                      <button className="icon-btn" title={t.bump} disabled={!!actioning} onClick={() => onBump(task.id)}>↑</button>
                      <button className="icon-btn danger" title={t.del} disabled={!!actioning} onClick={() => onDelete(task.id, task.title || task.id)}>✕</button>
                    </span>
                  </li>
                ))}
              </ul>
            ) : <p className="dim pad">{t.noData}</p>}

            {queue?.blocked && queue.blocked.length > 0 && (
              <>
                <h3 className="sub-h">{t.blockedTitle} <span className="sub-count">{queue.blocked.length}</span></h3>
                <ul className="task-list blocked-list">
                  {queue.blocked.map(task => (
                    <li key={task.id} className={`task-item${actioning === task.id ? ' acting' : ''}`}>
                      <span className="task-name" title={task.blockReason || task.title || task.id}>{task.title || task.id}</span>
                      {task.blockReason && <span className="block-reason" title={task.blockReason}>{task.blockReason}</span>}
                      <span className="row-actions">
                        <button className="icon-btn ok" title={t.retry} disabled={!!actioning} onClick={() => onRetry(task.id)}>↻</button>
                        <button className="icon-btn danger" title={t.del} disabled={!!actioning} onClick={() => onDelete(task.id, task.title || task.id)}>✕</button>
                      </span>
                    </li>
                  ))}
                </ul>
              </>
            )}
          </section>

          <section className="card">
            <h2 className="card-h">{t.history} <span className="card-hint">· {t.clickRow}</span></h2>
            {history.length > 0 ? (
              <div className="tbl-wrap">
                <table className="hist-tbl">
                  <thead>
                    <tr><th>#</th><th>{t.time}</th><th>{t.outcome}</th><th>{t.task}</th><th>{t.model}</th><th>{t.dur}</th></tr>
                  </thead>
                  <tbody>
                    {[...history].reverse().map((h, i) => (
                      <tr key={i} className="hist-row" onClick={() => openDecision(h.cycle)} title={t.decisionTitle + ' →'}>
                        <td className="mono">{h.cycle ?? '?'}</td>
                        <td className="mono dim">{h.ts ? new Date(h.ts).toLocaleTimeString([], { hour12: false }) : '—'}</td>
                        <td><span className={`pill pill-${outcomeCls(h.outcome)}`}>{h.outcome ?? '?'}</span></td>
                        <td className="task-cell" title={h.title || h.taskId || ''}>{h.title || h.taskId || '—'}</td>
                        <td className="mono dim">{modelShort(h)}</td>
                        <td className="mono dim">{fmtMs(h.durationMs)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            ) : <p className="dim pad">{lastAt ? t.noData : t.loading}</p>}
          </section>
        </div>
        {/* Live log tail */}
        <section className="card" style={{ marginBottom: 0 }}>
          <h2 className="card-h">
            {t.logTitle}
            {isRunning && <span className="live-dot" />}
          </h2>
          <div className="log-tail" ref={logTailRef}>
            {logs.length > 0
              ? logs.map((line, i) => <div key={i} className="log-line">{line}</div>)
              : <p className="dim pad">{t.noLogs}</p>}
          </div>
        </section>
      </main>

      {/* ══ Calibration modal ══ */}
      {showCalibrate && (
        <div className="drawer-overlay" onClick={() => setShowCalibrate(false)}>
          <div className="calib-modal" onClick={e => e.stopPropagation()}>
            <div className="calib-head">
              <h2 className="calib-title">{t.calibrateTitle}</h2>
              <button className="drawer-close" onClick={() => setShowCalibrate(false)}>✕</button>
            </div>
            <p className="hint" style={{ marginBottom: 16 }}>{t.calibrateHint}</p>
            <form onSubmit={onCalibrate} className="calib-form">
              <div className="calib-field">
                <label className="rail-lbl">{t.calibratePct}</label>
                <div className="calib-pct-row">
                  <input className="submit-input calib-input" type="number" min="1" max="100" step="0.1"
                    placeholder="e.g. 48" value={calibPct} onChange={e => setCalibPct(e.target.value)} required />
                  <span className="calib-unit">%</span>
                </div>
              </div>
              <div className="calib-field">
                <label className="rail-lbl">{t.calibrateQuota}</label>
                <input className="submit-input calib-input" type="text"
                  placeholder={`current: ${k(budget?.quota)} (leave blank to keep)`}
                  value={calibQuota} onChange={e => setCalibQuota(e.target.value)} />
              </div>
              <button className="btn btn-go" type="submit" disabled={busy || !calibPct.trim()} style={{ marginTop: 8 }}>
                {t.calibrateApply}
              </button>
            </form>
            {usage?.calibration && (
              <div className="calib-prev">
                <span className="rail-lbl" style={{ display: 'block', marginBottom: 6 }}>Last calibration</span>
                <span className="dim" style={{ fontSize: 12 }}>
                  {usage.calibration.calibratedPct != null ? `${usage.calibration.calibratedPct}%` : '—'}
                  {' '}· +{k(usage.calibration.externalOffset)} external tok
                  {' '}· {new Date(usage.calibration.calibratedAt).toLocaleString([], { hour12: false })}
                </span>
              </div>
            )}
          </div>
        </div>
      )}

      {/* ══ Decision drawer ══ */}
      {decision !== null && (
        <div className="drawer-overlay" onClick={() => setDecision(null)}>
          <aside className="drawer" onClick={e => e.stopPropagation()}>
            <div className="drawer-head">
              <div>
                <span className="drawer-eyebrow">{t.decisionTitle} · {t.cycle} {decision.cycle}</span>
                <h2 className="drawer-title">{decision.title || decision.task || '—'}</h2>
              </div>
              <button className="drawer-close" onClick={() => setDecision(null)} title={t.close}>✕</button>
            </div>
            {decisionLoading ? (
              <p className="dim pad">{t.loading}</p>
            ) : !decision.raw && !Object.keys(decision.fields || {}).length ? (
              <p className="dim pad">{t.noEntry}</p>
            ) : (
              <div className="drawer-body">
                <div className="drawer-meta">
                  {decision.task && <span className="tag">{decision.task}</span>}
                  {decision.goal && <span className="tag">{decision.goal}</span>}
                  {decision.outcome && <span className={`pill pill-${outcomeCls(decision.outcome)}`}>{decision.outcome}</span>}
                  {decision.ts && <span className="dim mono text-xs">{new Date(decision.ts).toLocaleString([], { hour12: false })}</span>}
                </div>
                {([
                  ['why', decision.fields.whyChosen],
                  ['whyBeat', decision.fields.whyItBeatTheAlternatives],
                  ['live2', decision.fields.whatIsNowLive],
                  ['validation', decision.fields.validation],
                  ['verdict', decision.fields.reviewVerdict],
                  ['impl', decision.fields.implementerModel],
                  ['diff', decision.fields.fileLevelDiff],
                  ['notes', decision.fields.notes],
                ] as const).filter(([, v]) => v).map(([labelKey, v]) => (
                  <div className="drawer-field" key={labelKey}>
                    <span className="drawer-flabel">{t[labelKey as keyof typeof t]}</span>
                    <p className="drawer-fval">{v}</p>
                  </div>
                ))}
              </div>
            )}
          </aside>
        </div>
      )}

      {toast && <div className="toast">{toast}</div>}
    </div>
  );
}
