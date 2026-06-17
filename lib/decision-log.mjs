// decision-log.mjs — parse the human-readable decision_log.md into structured per-cycle entries so the
// control center can render each cycle's decision (what was chosen, why, the outcome, what shipped)
// instead of making the user `cat` a 400 KB markdown file.
//
// The log format (one block per cycle, written by the supervisor):
//   ## Cycle <n> — <ISO timestamp>
//   - **Task:** <id> — <title>
//   - **Goal phase:** <goal>
//   - **Why chosen:** <text>
//   - **Outcome:** <merged|blocked|…>
//   - **USER IMPACT SUMMARY:** <text>
//   - **WHAT IS NOW LIVE:** <text>
//   - **File-level diff:** … (indented block)
//   - **Notes:** <text>
// Fields vary by cycle; we capture the bold-label fields generically + keep the raw block.

const CYCLE_RE = /^##\s+Cycle\s+(\d+)\s+—\s+(.+?)\s*$/;

// Map a bold label to a stable camelCase key.
function keyFor(label) {
  return label.trim().toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ').trim()
    .split(' ').map((w, i) => i === 0 ? w : w[0].toUpperCase() + w.slice(1)).join('');
}

/**
 * Parse the full decision_log.md text into an array of entries (in file order, i.e. oldest → newest).
 * Each entry: { cycle, ts, fields: { <key>: value }, task, title, goal, outcome, raw }.
 */
export function parseDecisionLog(text) {
  const lines = String(text || '').split(/\r?\n/);
  const entries = [];
  let cur = null;

  const push = () => { if (cur) { cur.raw = cur._rawLines.join('\n').trim(); delete cur._rawLines; entries.push(cur); } };

  for (const line of lines) {
    const m = CYCLE_RE.exec(line);
    if (m) {
      push();
      cur = { cycle: Number(m[1]), ts: m[2].trim(), fields: {}, _rawLines: [line] };
      continue;
    }
    if (!cur) continue;
    cur._rawLines.push(line);
    // Capture "- **Label:** value" pairs.
    const fm = /^-\s+\*\*(.+?):\*\*\s*(.*)$/.exec(line);
    if (fm) {
      const key = keyFor(fm[1]);
      cur.fields[key] = fm[2].trim();
    }
  }
  push();

  // Derive convenience top-level fields the UI uses for list rows.
  for (const e of entries) {
    const taskField = e.fields.task || '';
    const dash = taskField.indexOf('—');
    e.task = dash >= 0 ? taskField.slice(0, dash).trim() : taskField; // the task id
    e.title = dash >= 0 ? taskField.slice(dash + 1).trim() : '';
    e.goal = e.fields.goalPhase || e.fields.goal || '';
    e.outcome = e.fields.outcome || '';
  }
  return entries;
}

/** Lightweight summary (no raw block) for list views. */
export function summarizeEntry(e) {
  return {
    cycle: e.cycle, ts: e.ts, task: e.task, title: e.title, goal: e.goal,
    outcome: e.outcome,
    whyChosen: e.fields.whyChosen || '',
    model: e.fields.implementerModel || '',
  };
}

/**
 * Return the last `n` entries as summaries (newest first), plus optionally the FULL entry for a
 * specific cycle (so the UI fetches the heavy raw block only on demand).
 */
export function selectEntries(text, { n = 40, cycle = null } = {}) {
  const all = parseDecisionLog(text);
  const summaries = all.slice(-n).reverse().map(summarizeEntry);
  let full = null;
  if (cycle != null) {
    const e = all.find((x) => x.cycle === Number(cycle));
    if (e) full = { cycle: e.cycle, ts: e.ts, fields: e.fields, task: e.task, title: e.title, goal: e.goal, outcome: e.outcome, raw: e.raw };
  }
  return { count: all.length, summaries, full };
}
