// statusline-capture.mjs — injected as CLAUDE_CODE_STATUS_COMMAND in claude.mjs.
// Claude Code v2.1.80+ pipes a JSON blob to this script on each turn completion.
// We extract rate_limits and write a trusted snapshot to state/usage-snapshot.json
// so the supervisor can use real Anthropic reset times instead of hardcoded anchors.
//
// Input (stdin): Claude Code statusline JSON, e.g.:
//   { "rate_limits": { "five_hour": { "used_percentage": 42, "resets_at": 1711540800 }, ... } }
// Output: state/usage-snapshot.json (written atomically via tmp file)

import { writeFileSync, mkdirSync, renameSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import os from 'node:os';
import { randomBytes } from 'node:crypto';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SNAPSHOT_PATH = path.resolve(__dirname, '..', 'state', 'usage-snapshot.json');

let raw = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (chunk) => { raw += chunk; });
process.stdin.on('end', () => {
  try {
    const data = JSON.parse(raw.trim());
    const rl = data.rate_limits;
    // Only write if we got actual rate_limit data (not all payloads include it)
    if (!rl || (!rl.five_hour && !rl.seven_day)) process.exit(0);

    const toEntry = (w) => w ? {
      usedPercent: typeof w.used_percentage === 'number' ? w.used_percentage : null,
      // resets_at can be Unix seconds (10-digit) or ms (13-digit)
      resetAt: typeof w.resets_at === 'number'
        ? (w.resets_at < 1e12 ? w.resets_at * 1000 : w.resets_at)
        : null,
    } : null;

    const snapshot = {
      observedAt: Date.now(),
      fiveHour: toEntry(rl.five_hour),
      sevenDay: toEntry(rl.seven_day),
      source: 'statusline',
      trust: 'high',
    };

    mkdirSync(path.dirname(SNAPSHOT_PATH), { recursive: true });
    // Atomic write: tmp → rename, avoids a partial read if supervisor reads mid-write
    const tmp = path.join(os.tmpdir(), `ks-usage-${randomBytes(4).toString('hex')}.json`);
    writeFileSync(tmp, JSON.stringify(snapshot, null, 2), 'utf8');
    renameSync(tmp, SNAPSHOT_PATH);
  } catch {
    // Non-fatal: if the payload isn't parseable or has no rate data, just skip
  }
  process.exit(0);
});
