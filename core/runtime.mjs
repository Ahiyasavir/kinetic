// core/runtime.mjs — the generic, project-agnostic role-invocation runtime shared by every kinetic
// agent role (selector / implementer / reviewer / auditor). It holds ONLY the workflow mechanics that
// are identical across host projects:
//   • renderPrompt()      — fill a prompt template's {{VARS}}
//   • extractJsonObject() — pull the first balanced top-level JSON object out of a model's text
//   • readHandoff()       — robustly parse a role's handoff file
//   • clearHandoff()      — reset the handoff directory between cycles
//   • createRoleRunner()  — bind a host context once, return a generic invokeRole + handoff helpers
//
// It hardcodes NOTHING about any specific product (no RushPoint paths, Firestore, app layout, scoring,
// or git). Everything project-specific (the prompt directory, the handoff directory, the working dir,
// config, the Claude runner, and the usage/log hooks) is INJECTED by the caller. supervisor.mjs keeps
// the RushPoint-specific glue (config.json, paths, scoring, validation, git) and wires it in here.

import { readFile, rm, mkdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { resolveModelForRole } from './providers.mjs';

// Render a prompt template: read `${promptDir}/${name}.md` and substitute every {{VAR}} from `vars`.
export async function renderPrompt(promptDir, name, vars) {
  let tpl = await readFile(path.join(promptDir, `${name}.md`), 'utf8');
  for (const [k, v] of Object.entries(vars)) tpl = tpl.replaceAll(`{{${k}}}`, String(v));
  return tpl;
}

// Extract the first COMPLETE top-level JSON object from text, ignoring ```json fences and any prose
// before/after (a model sometimes appends "I've written the file. }"). Brace-balanced + string-aware
// so a `}` inside a string value or trailing prose can't truncate or over-extend the parse.
export function extractJsonObject(text) {
  if (!text) return null;
  const s = text.indexOf('{');
  if (s < 0) return null;
  let depth = 0, inStr = false, esc = false;
  for (let i = s; i < text.length; i++) {
    const c = text[i];
    if (inStr) {
      if (esc) esc = false;
      else if (c === '\\') esc = true;
      else if (c === '"') inStr = false;
    } else if (c === '"') inStr = true;
    else if (c === '{') depth++;
    else if (c === '}') { depth--; if (depth === 0) return text.slice(s, i + 1); }
  }
  return null; // unbalanced — incomplete object
}

// Read + robustly parse a role's handoff file from `handoffDir`. Tolerates a fenced/embedded object
// and trailing prose: 1) strict whole-file parse  2) balanced embedded object  3) first-{…-last-} slice.
export async function readHandoff(handoffDir, file) {
  const p = path.join(handoffDir, file);
  if (!existsSync(p)) return null;
  try {
    const raw = await readFile(p, 'utf8');
    try { return JSON.parse(raw.trim()); } catch { /* try extraction */ }
    const obj = extractJsonObject(raw);
    if (obj) { try { return JSON.parse(obj); } catch { /* fall through */ } }
    const start = raw.indexOf('{'), end = raw.lastIndexOf('}');
    if (start >= 0 && end > start) return JSON.parse(raw.slice(start, end + 1));
    return null;
  } catch { return null; }
}

// Reset the handoff directory between cycles (delete + recreate empty).
export async function clearHandoff(handoffDir) {
  await rm(handoffDir, { recursive: true, force: true });
  await mkdir(handoffDir, { recursive: true });
}

/**
 * Bind a host context once and return the generic role runner. The returned `invokeRole` renders the
 * named prompt, resolves the model (explicit override → config.models[name] → config.model), runs the
 * injected Claude runner, and forwards usage to the host's metering hook — all without any knowledge of
 * the host project. `readHandoff` / `clearHandoff` are pre-bound to the host's handoff directory.
 *
 * @param {object} ctx
 * @param {string} ctx.promptDir   absolute path to the role prompt templates (`<name>.md`)
 * @param {string} ctx.handoffDir  absolute path to the per-cycle handoff directory
 * @param {string} ctx.cwd         working directory for the Claude runner
 * @param {object} ctx.config      project config (provides `models` map + default `model`)
 * @param {Function} ctx.runClaude async ({prompt,cwd,config,label,model}) => result (host-provided)
 * @param {Function} [ctx.onUsage] called with each role result for usage self-metering
 * @param {Function} [ctx.log]     logger (name + model line, is_error notice)
 * @param {Function} [ctx.resolveName] map a role's generic handoff basename to its on-disk name
 *                                      (host-injected, e.g. context-aware tagging); defaults to identity.
 * @param {Function} [ctx.validateHandoff] called with (onDiskName, parsedData) right after a handoff is
 *                                      read, so the host can validate its schema version / project scope
 *                                      and log a migration message (host-injected; defaults to no-op).
 */
export function createRoleRunner({ promptDir, handoffDir, cwd, config, runClaude, onUsage, log, resolveName, validateHandoff }) {
  const _log = log || (() => {});
  const _resolveName = resolveName || ((f) => f);
  const _validate = validateHandoff || (() => {});
  async function invokeRole(name, vars, modelOverride) {
    const prompt = await renderPrompt(promptDir, name, vars);
    const model = modelOverride || resolveModelForRole(name, name, config) || config.model;
    _log(`→ claude (${name} · ${model})`);
    const res = await runClaude({ prompt, cwd, config, label: name, model });
    if (onUsage) onUsage(res);
    if (!res.ok) _log(`  (${name} returned is_error; continuing to inspect handoff)`);
    return res;
  }
  return {
    invokeRole,
    readHandoff: async (file) => {
      const name = _resolveName(file);
      const data = await readHandoff(handoffDir, name);
      _validate(name, data); // host validates schema version / project scope (U-34); never throws
      return data;
    },
    clearHandoff: () => clearHandoff(handoffDir),
  };
}
