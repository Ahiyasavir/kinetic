import React, { useEffect, useRef, useState } from 'react';

// ── i18n ──────────────────────────────────────────────────────────────────────
const LANG_KEY = 'autopilot-ui-language';
type Lang = 'EN' | 'HE';

const STRINGS = {
  EN: {
    title: 'Autopilot Dashboard',
    queues: 'Active Queues',
    budget: 'Budget Pacing',
    history: 'Cycle History',
    backlog: 'Backlog',
    done: 'Done',
    blocked: 'Blocked',
    cycle: 'Cycle',
    time: 'Time',
    outcome: 'Outcome',
    task: 'Task',
    dur: 'Duration',
    cost: 'Cost',
    tokens: 'Tokens used',
    quota: 'Quota',
    remaining: 'Cycles left',
    usd: 'Cost (USD)',
    noData: 'No data yet — start the engine first.',
    loading: 'Loading…',
    polling: 'Live · 10s refresh',
  },
  HE: {
    title: 'לוח בקרה אוטופילוט',
    queues: 'תורים פעילים',
    budget: 'מדריך תקציב',
    history: 'היסטוריית מחזורים',
    backlog: 'בצבר',
    done: 'הושלם',
    blocked: 'חסום',
    cycle: 'מחזור',
    time: 'שעה',
    outcome: 'תוצאה',
    task: 'משימה',
    dur: 'משך',
    cost: 'עלות',
    tokens: 'טוקנים בשימוש',
    quota: 'מכסה',
    remaining: 'מחזורים נותרו',
    usd: 'עלות (USD)',
    noData: 'אין נתונים עדיין',
    loading: 'טוען…',
    polling: 'חי · רענון 10 שניות',
  },
} as const;

// ── types ─────────────────────────────────────────────────────────────────────
interface WorkspaceInfo { id: string; label: string; }

interface TaskRow {
  id: string;
  title?: string;
  goal?: string;
  risk?: number | null;
  status?: string | null;
  userRequested?: boolean;
}

interface QueueState {
  backlog: TaskRow[];
  done: TaskRow[];
  blocked: TaskRow[];
  exists: boolean;
}

interface BudgetState {
  spent: number;
  quota: number;
  fractionUsed: number;
  cyclesLeft: number | null;
  usage: {
    cycles: number;
    costUsd: number;
    inputTokens: number;
    outputTokens: number;
    cacheReadTokens?: number;
    cacheCreationTokens?: number;
  };
}

interface HistEntry {
  cycle?: number;
  ts?: string;
  outcome?: string;
  taskId?: string;
  title?: string;
  costUsd?: number | null;
  durationMs?: number | null;
}

// ── helpers ───────────────────────────────────────────────────────────────────
function k(n: number | null | undefined): string {
  if (n == null || !isFinite(n as number)) return '∞';
  const v = n as number;
  if (Math.abs(v) >= 1e6) return (v / 1e6).toFixed(1) + 'M';
  if (Math.abs(v) >= 1e3) return Math.round(v / 1e3) + 'k';
  return String(v);
}

function fmtMs(d?: number | null): string {
  if (!d) return '—';
  if (d >= 60000) return (d / 60000).toFixed(1) + 'm';
  return Math.round(d / 1000) + 's';
}

function outcomeCls(o?: string): string {
  const s = String(o || '').toLowerCase();
  if (s.includes('approv') || s.includes('pass') || s === 'done') return 'ok';
  if (s.includes('reject') || s.includes('fail')) return 'bad';
  if (s.includes('skip') || s.includes('bypass') || s.includes('block')) return 'warn';
  return 'other';
}

// ── component ─────────────────────────────────────────────────────────────────
export default function App(): JSX.Element {
  const [lang, setLang] = useState<Lang>(() => {
    try { return (localStorage.getItem(LANG_KEY) as Lang) || 'EN'; } catch { return 'EN'; }
  });
  const t = STRINGS[lang];
  const isHE = lang === 'HE';

  const [wsId, setWsId] = useState('');
  const [workspaces, setWorkspaces] = useState<WorkspaceInfo[]>([]);
  const [queue, setQueue] = useState<QueueState | null>(null);
  const [budget, setBudget] = useState<BudgetState | null>(null);
  const [history, setHistory] = useState<HistEntry[]>([]);
  const [sortAsc, setSortAsc] = useState(false);
  const [lastAt, setLastAt] = useState('');
  const [error, setError] = useState('');
  const timerRef = useRef<ReturnType<typeof setInterval> | null>(null);

  function toggleLang() {
    const next: Lang = lang === 'EN' ? 'HE' : 'EN';
    try { localStorage.setItem(LANG_KEY, next); } catch {}
    document.documentElement.dir = next === 'HE' ? 'rtl' : 'ltr';
    setLang(next);
  }

  // Load workspaces on mount
  useEffect(() => {
    document.documentElement.dir = isHE ? 'rtl' : 'ltr';
    fetch('/api/workspaces')
      .then(r => r.json())
      .then((d: { workspaces?: Array<{ id: string; label?: string }>; defaultId?: string }) => {
        const ws: WorkspaceInfo[] = (d.workspaces || []).map(w => ({ id: w.id, label: w.label || w.id }));
        setWorkspaces(ws);
        setWsId(d.defaultId || ws[0]?.id || '');
      })
      .catch(() => setError('Cannot reach server — run: npm run ui:dev'));
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  // Poll metrics whenever wsId changes
  useEffect(() => {
    if (!wsId) return;
    if (timerRef.current) clearInterval(timerRef.current);

    const poll = async () => {
      try {
        const enc = encodeURIComponent(wsId);
        const [qData, bData, aData] = await Promise.all([
          fetch(`/api/queues?ws=${enc}`).then(r => r.json()),
          fetch(`/api/budget?ws=${enc}`).then(r => r.json()),
          fetch(`/api/activity?ws=${enc}&n=50`).then(r => r.json()),
        ]);
        setQueue(qData as QueueState);
        setBudget(bData as BudgetState);
        setHistory((aData as { history?: HistEntry[] }).history || []);
        setLastAt(new Date().toLocaleTimeString([], { hour12: false }));
        setError('');
      } catch (e) {
        setError(String(e));
      }
    };

    poll();
    timerRef.current = setInterval(poll, 10000);
    return () => { if (timerRef.current) clearInterval(timerRef.current); };
  }, [wsId]);

  const pct = budget ? Math.min(100, Math.round((budget.fractionUsed ?? 0) * 100)) : 0;
  const barColor = pct >= 90 ? 'var(--bad)' : pct >= 70 ? 'var(--warn)' : 'var(--accent)';
  const sorted = [...history].sort((a, b) =>
    sortAsc ? (a.cycle ?? 0) - (b.cycle ?? 0) : (b.cycle ?? 0) - (a.cycle ?? 0)
  );

  return (
    <div className={`app${isHE ? ' rtl' : ''}`}>
      {/* Header */}
      <header className="hdr">
        <span className="hdr-title">{t.title}</span>
        <span className="spacer" />
        {workspaces.length > 1 && (
          <select className="ws-sel" value={wsId} onChange={e => setWsId(e.target.value)}>
            {workspaces.map(w => <option key={w.id} value={w.id}>{w.label}</option>)}
          </select>
        )}
        {lastAt && <span className="dim mono text-xs">{t.polling}</span>}
        <button className="lang-btn" onClick={toggleLang} title="Toggle language / שנה שפה">
          {lang === 'EN' ? 'HE' : 'EN'}
        </button>
      </header>

      {error && <div className="err-bar">{error}</div>}

      <main className="grid">
        {/* ── Queue panel ── */}
        <section className="card">
          <h2 className="card-h">{t.queues}</h2>
          <div className="q-row">
            {(['backlog', 'done', 'blocked'] as const).map(key => (
              <div key={key} className={`q-badge q-${key}`}>
                <span className="q-num">{queue?.[key]?.length ?? '—'}</span>
                <span className="q-lbl">{t[key]}</span>
              </div>
            ))}
          </div>
          {queue?.backlog && queue.backlog.length > 0 && (
            <ul className="task-list">
              {queue.backlog.slice(0, 10).map(task => (
                <li key={task.id} className="task-item">
                  {task.userRequested && <span className="star">★</span>}
                  <span className="task-name">{task.title || task.id}</span>
                  {task.goal && <span className="tag">{task.goal}</span>}
                  {task.risk != null && <span className="tag">r{task.risk}</span>}
                </li>
              ))}
            </ul>
          )}
          {queue && !queue.exists && <p className="dim">{t.noData}</p>}
        </section>

        {/* ── Budget gauge ── */}
        <section className="card">
          <h2 className="card-h">{t.budget}</h2>
          {budget ? (
            <>
              <div className="kv"><span className="kv-k">{t.tokens}</span><span className="kv-v mono">{k(budget.spent)} / {k(budget.quota)}</span></div>
              <div className="kv"><span className="kv-k">{t.remaining}</span><span className="kv-v mono">{budget.cyclesLeft === null ? '∞' : budget.cyclesLeft}</span></div>
              <div className="kv"><span className="kv-k">{t.usd}</span><span className="kv-v mono">${(budget.usage?.costUsd ?? 0).toFixed(4)}</span></div>
              <div className="bar-wrap">
                <div className="bar-labels">
                  <span>0</span>
                  <span className="dim">{pct}%</span>
                  <span>{k(budget.quota)}</span>
                </div>
                <div className="bar-track">
                  <div className="bar-fill" style={{ width: `${pct}%`, background: barColor }} />
                </div>
              </div>
              <div className="token-tags">
                <span className="tag">in: {k(budget.usage?.inputTokens)}</span>
                <span className="tag">out: {k(budget.usage?.outputTokens)}</span>
                <span className="tag">cache: {k(budget.usage?.cacheReadTokens)}</span>
              </div>
            </>
          ) : <span className="dim">{error ? '' : t.loading}</span>}
        </section>

        {/* ── Cycle history ── */}
        <section className="card full">
          <h2 className="card-h">
            {t.history}
            <button className="sort-btn" onClick={() => setSortAsc(a => !a)} title="Toggle sort order">
              {sortAsc ? '↑' : '↓'}
            </button>
          </h2>
          {sorted.length > 0 ? (
            <div className="tbl-wrap">
              <table className="hist-tbl">
                <thead>
                  <tr>
                    <th>{t.cycle}</th>
                    <th>{t.time}</th>
                    <th>{t.outcome}</th>
                    <th>{t.task}</th>
                    <th>{t.dur}</th>
                    <th>{t.cost}</th>
                  </tr>
                </thead>
                <tbody>
                  {sorted.map((h, i) => (
                    <tr key={i}>
                      <td className="mono">#{h.cycle ?? '?'}</td>
                      <td className="mono dim">{h.ts ? new Date(h.ts).toLocaleTimeString([], { hour12: false }) : '—'}</td>
                      <td><span className={`pill pill-${outcomeCls(h.outcome)}`}>{h.outcome ?? '?'}</span></td>
                      <td className="task-cell">{h.title || h.taskId || '—'}</td>
                      <td className="mono dim">{fmtMs(h.durationMs)}</td>
                      <td className="mono dim">{h.costUsd != null ? `$${h.costUsd.toFixed(4)}` : '—'}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          ) : (
            <span className="dim">{lastAt ? t.noData : t.loading}</span>
          )}
        </section>
      </main>
    </div>
  );
}
