// claude.mjs — run the Claude Code CLI headless (`claude -p`) for one role, parse the JSON result,
// and detect usage/rate limits. The prompt is piped via stdin to avoid argv length limits.
import { spawn, spawnSync } from 'node:child_process';
import path from 'node:path';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

// ACCOUNT PINNING: the kinetic always authenticates with its OWN snapshot of the Claude login
// (autopilot/.account/.credentials.json — OAuth for the pinned account) via CLAUDE_CONFIG_DIR, so it
// keeps running on that account even if the user switches accounts in their main ~/.claude session.
// The snapshot holds a refreshToken, so the CLI auto-refreshes the token in-place there.
const ACCOUNT_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '.account');
// Path to the statusline capture script — set as CLAUDE_CODE_STATUS_COMMAND so Claude Code
// pipes its rate_limits JSON to us on each turn, giving us real 5h/7d reset timestamps.
const STATUSLINE_CAPTURE = path.resolve(path.dirname(fileURLToPath(import.meta.url)), 'statusline-capture.mjs');

function pinnedEnv(apiKey) {
  const env = { ...process.env };
  // KEY POOLING (Stage 1): when the KeyManager hands us a pool key, it takes precedence over the
  // pinned OAuth account — inject it as ANTHROPIC_API_KEY and DON'T force the OAuth config-dir, so the
  // CLI authenticates with this specific pooled account. This is what lets the engine rotate keys.
  if (apiKey) {
    env.ANTHROPIC_API_KEY = apiKey;
    delete env.CLAUDE_CONFIG_DIR;
    delete env.ANTHROPIC_AUTH_TOKEN;
  } else if (existsSync(path.join(ACCOUNT_DIR, '.credentials.json'))) {
    env.CLAUDE_CONFIG_DIR = ACCOUNT_DIR;
    // Force the OAuth config-dir path (not a stray API key from the parent env) so the pin is definitive.
    delete env.ANTHROPIC_API_KEY;
    delete env.ANTHROPIC_AUTH_TOKEN;
  }
  // Statusline capture: Claude Code v2.1.80+ pipes rate_limits JSON to this script on each turn,
  // giving the supervisor real 5h/7d reset timestamps for accurate rate-limit pausing.
  // Uses the same node binary that's running this process so it always resolves correctly.
  env.CLAUDE_CODE_STATUS_COMMAND = `"${process.execPath}" "${STATUSLINE_CAPTURE}"`;
  return env;
}

export class RateLimitError extends Error {
  constructor(message, retryAfterMs) {
    super(message);
    this.name = 'RateLimitError';
    this.retryAfterMs = retryAfterMs || null;
  }
}

const RATE_LIMIT_PATTERNS = [
  /usage limit reached/i,
  /rate limit/i,
  /too many requests/i,
  /429/,
  /overloaded/i,
  /quota/i
];

function looksRateLimited(text) {
  return RATE_LIMIT_PATTERNS.some((re) => re.test(text || ''));
}

// Best-effort: pull a real "retry after" hint out of the CLI/API message so we wait exactly as long as
// needed instead of guessing with exponential backoff. Handles: epoch reset, "retry-after: N" seconds,
// and "in N minute(s)/hour(s)". Returns ms, or null if nothing parseable.
function parseRetryMs(text) {
  const t = text || '';
  // 1) explicit epoch reset ("resets at 1730000000")
  let m = /resets?\s+at\s+(\d{10,13})/i.exec(t);
  if (m) {
    const ts = m[1].length === 13 ? Number(m[1]) : Number(m[1]) * 1000;
    const delta = ts - Date.now();
    if (delta > 0) return delta;
  }
  // 2) Retry-After header style ("retry-after: 120" → seconds)
  m = /retry[-\s]?after["':\s]+(\d{1,6})/i.exec(t);
  if (m) { const s = Number(m[1]); if (s > 0 && s < 86400) return s * 1000; }
  // 3) natural language ("try again in 17 minutes" / "in 2 hours")
  m = /in\s+(\d{1,4})\s*(second|minute|hour)/i.exec(t);
  if (m) {
    const n = Number(m[1]); const unit = m[2].toLowerCase();
    const mul = unit === 'hour' ? 3600000 : unit === 'minute' ? 60000 : 1000;
    if (n > 0) return n * mul;
  }
  return null;
}

/**
 * Run one Claude invocation.
 * @returns {Promise<{ok:boolean, text:string, raw:object|null, rateLimited:boolean}>}
 */
export function runClaude({ prompt, cwd, config, label, model, apiKey }) {
  return new Promise((resolve, reject) => {
    const args = [
      '-p',
      '--model', model || config.model,
      '--output-format', config.cli.outputFormat,
      config.cli.permission,
      '--max-turns', String(config.cli.maxTurnsPerCall)
    ];

    const child = spawn(config.cli.bin, args, {
      cwd,
      shell: true, // Windows: resolves claude.cmd on PATH
      stdio: ['pipe', 'pipe', 'pipe'],
      // Auth with the injected pool key when present (key rotation), else the pinned account snapshot.
      env: pinnedEnv(apiKey)
    });

    let stdout = '';
    let stderr = '';
    let killedForTimeout = false;

    const timer = setTimeout(() => {
      killedForTimeout = true;
      // On Windows with shell:true, child.kill() kills only the cmd.exe wrapper but the
      // grandchild (claude.exe) keeps the pipes open → close event never fires → hang.
      // taskkill /T /F kills the entire process tree including inherited pipe handles.
      if (process.platform === 'win32') {
        spawnSync('taskkill', ['/PID', String(child.pid), '/T', '/F'], { stdio: 'ignore' });
      } else {
        try { process.kill(-child.pid, 'SIGKILL'); } catch { child.kill('SIGKILL'); }
      }
    }, config.cli.timeoutMs);

    child.stdout.on('data', (d) => (stdout += d.toString()));
    child.stderr.on('data', (d) => (stderr += d.toString()));

    child.on('error', (err) => {
      clearTimeout(timer);
      reject(new Error(`[${label}] failed to spawn claude: ${err.message}`));
    });

    child.on('close', (code) => {
      clearTimeout(timer);
      const combined = stdout + '\n' + stderr;

      if (killedForTimeout) {
        return reject(new Error(`[${label}] claude timed out after ${config.cli.timeoutMs}ms`));
      }

      // Try to parse the structured JSON result.
      let raw = null;
      try {
        raw = JSON.parse(stdout.trim());
      } catch {
        // Fall back to scanning for the last JSON object on stdout.
        const start = stdout.lastIndexOf('{');
        if (start >= 0) {
          try { raw = JSON.parse(stdout.slice(start)); } catch { /* ignore */ }
        }
      }

      const resultText = raw?.result ?? stdout;
      const isErr = raw?.is_error === true || code !== 0;

      // Rate limit can show up in the result text, stderr, or as is_error with a quota message.
      if (looksRateLimited(combined)) {
        return reject(new RateLimitError(`[${label}] usage/rate limit hit`, parseRetryMs(combined)));
      }

      if (isErr && raw == null && code !== 0) {
        return reject(new Error(`[${label}] claude exited ${code}: ${stderr.slice(0, 500)}`));
      }

      resolve({
        ok: !isErr,
        text: typeof resultText === 'string' ? resultText : JSON.stringify(resultText),
        raw,
        rateLimited: false,
        // Self-metering for the weekly-budget pacer: the CLI `--output-format json` result carries
        // per-call token usage and a notional cost. Null when the result wasn't parseable.
        usage: raw?.usage ?? null,
        costUsd: typeof raw?.total_cost_usd === 'number' ? raw.total_cost_usd : null
      });
    });

    child.stdin.write(prompt);
    child.stdin.end();
  });
}
