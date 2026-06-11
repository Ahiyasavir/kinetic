// auto-fix.mjs — run eslint --fix and import-sort before validation to eliminate trivial issues.
// This module invokes linting auto-fixes deterministically, stages the changes, and reports what was fixed.
// The validation phase can then skip the AI revision cycle if auto-fixes resolved all errors.
//
// Enhanced for U-46: explicit error counting before/after to track auto-fixed vs AI-resolved errors.

import { exec } from 'node:child_process';
import { autoFix as defaultAutoFixConfig, lintCommand } from '../config-loader.mjs';

function run(cmd, cwd, timeoutMs) {
  return new Promise((resolve) => {
    exec(cmd, { cwd, timeout: timeoutMs, maxBuffer: 32 * 1024 * 1024, shell: true }, (err, stdout, stderr) => {
      resolve({
        ok: !err,
        code: err ? err.code ?? 1 : 0,
        full: stdout + '\n' + stderr,
        tail: (stdout + '\n' + stderr).slice(-2000)
      });
    });
  });
}

/**
 * Count total ESLint error count from linting output, parsing "✖ N problems (E errors, W warnings)"
 * @param {string} output - full linting command output (stdout + stderr)
 * @returns {number} total error count, or null if parsing fails
 */
function parseLintErrorCount(output) {
  let total = 0;
  const re = /\((\d+)\s+errors?/g;
  let m;
  while ((m = re.exec(output))) {
    total += Number(m[1]);
  }
  return total > 0 ? total : null;
}

/**
 * Extract tool name from a command string for logging.
 * E.g. "npm run lint:fix" → "eslint", "npm run format" → "prettier"
 * @param {string} cmd - the command string
 * @returns {string} a human-readable tool name
 */
function toolNameFromCommand(cmd) {
  if (!cmd) return 'unknown-tool';
  if (cmd.includes('lint:fix') || cmd.includes('eslint')) return 'eslint';
  if (cmd.includes('format') || cmd.includes('prettier')) return 'prettier';
  if (cmd.includes('import')) return 'import-sort';
  // fallback: return the first word after 'npm run'
  const m = /npm\s+run\s+(\S+)/.exec(cmd);
  return m ? m[1] : 'unknown-tool';
}

/**
 * Run auto-fixes (eslint --fix + import-sort) on the target repo.
 * Counts errors before and after to report explicitly what was auto-fixed vs remains for AI.
 * Stages and commits the fixes, then reports detailed metrics.
 *
 * @param {object} config   the project config (contains autoFix block)
 * @param {string} cwd      working directory (git root)
 * @param {object} git      git helper module (see lib/git.mjs)
 * @param {Function} log    logging function
 * @returns {Promise<{ok:boolean, fixed:boolean, fixedLint:boolean, fixedImports:boolean, summary:string, committed:boolean, errorsBefore:number|null, errorsAfter:number|null, errorsFixed:number|null}>}
 */
export async function runAutoFixes(config, cwd, git, log) {
  const autoFixCfg = (config && config.autoFix) || defaultAutoFixConfig || {};
  if (!autoFixCfg.enabled) {
    return {
      ok: true,
      fixed: false,
      fixedLint: false,
      fixedImports: false,
      summary: 'auto-fix disabled',
      committed: false,
      errorsBefore: null,
      errorsAfter: null,
      errorsFixed: null
    };
  }

  const results = [];
  let errorsBefore = null;
  let errorsAfter = null;
  let errorsFixed = null;

  // === Count baseline lint errors BEFORE auto-fix ===
  // Get the lint command from config; if there's a lintFixCommand, use the base lint (non-fix) version
  const baseLinCfg = (config && config.validation) || {};
  const baseLintCmd = baseLinCfg.commands?.find((c) => c.name === 'lint')?.cmd || lintCommand();
  if (baseLintCmd) {
    log('Counting baseline lint errors…');
    const baselineResult = await run(baseLintCmd, cwd, autoFixCfg.timeoutMs || 600000);
    errorsBefore = parseLintErrorCount(baselineResult.full);
    if (errorsBefore !== null) {
      log(`  Found ${errorsBefore} lint error(s) before auto-fix`);
    }
  }

  // === Run linting auto-fix ===
  // Note: linting tools modify files in-place; exit code 0 means all errors fixed, 1 means some remain.
  if (autoFixCfg.lintFixCommand) {
    const lintTool = toolNameFromCommand(autoFixCfg.lintFixCommand);
    log(`Running ${lintTool} auto-fix…`);
    const lintResult = await run(autoFixCfg.lintFixCommand, cwd, autoFixCfg.timeoutMs || 600000);
    results.push({
      tool: lintTool,
      ok: lintResult.ok,
      output: lintResult.tail
    });
    if (lintResult.ok) {
      log(`✓ ${lintTool} auto-fix completed successfully`);
    } else {
      log(`✓ ${lintTool} auto-fix ran (some errors may remain that require manual fixes)`);
    }
  }

  // === Run import-sorting ===
  // Typically this is prettier --write which handles both formatting and import reordering.
  if (autoFixCfg.importSortCommand) {
    const importTool = toolNameFromCommand(autoFixCfg.importSortCommand);
    log(`Running ${importTool} (formatting + import sorting)…`);
    const importResult = await run(autoFixCfg.importSortCommand, cwd, autoFixCfg.timeoutMs || 600000);
    results.push({
      tool: importTool,
      ok: importResult.ok,
      output: importResult.tail
    });
    if (importResult.ok) {
      log(`✓ ${importTool} formatting + import sorting completed successfully`);
    } else {
      log(`✓ ${importTool} ran (some errors may remain that require manual fixes)`);
    }
  }

  // === Count lint errors AFTER auto-fix ===
  // Re-run the base lint command to see how many errors remain
  if (baseLintCmd && (autoFixCfg.lintFixCommand || autoFixCfg.importSortCommand)) {
    log('Counting lint errors after auto-fix…');
    const afterResult = await run(baseLintCmd, cwd, autoFixCfg.timeoutMs || 600000);
    errorsAfter = parseLintErrorCount(afterResult.full);
    if (errorsAfter !== null) {
      log(`  Found ${errorsAfter} lint error(s) after auto-fix`);
    }
    // Calculate the delta
    if (errorsBefore !== null && errorsAfter !== null) {
      errorsFixed = Math.max(0, errorsBefore - errorsAfter);
      if (errorsFixed > 0) {
        log(`  ✓ Auto-fixed ${errorsFixed} error(s)`);
      }
    }
  }

  // === Stage and commit auto-fixes if there are any file changes ===
  // Both eslint --fix and import-sort modify files in-place. We commit whatever changes they made,
  // regardless of whether all errors were fixed. This ensures partial fixes are committed and
  // residual errors are reported to the implementer separately.
  let committed = false;
  let fixed = false;  // true if we actually committed any changes
  if (git && (autoFixCfg.lintFixCommand || autoFixCfg.importSortCommand)) {
    try {
      const clean = await git.isClean(cwd);
      if (!clean) {
        const message = `${config?.git?.commitPrefix || 'kinetic'}: auto-fix eslint + import-sort`;
        const didCommit = await git.commitAllIfDirty(cwd, message);
        if (didCommit) {
          committed = true;
          fixed = true;
          log('✓ Auto-fixes committed');
        }
      }
    } catch (e) {
      log(`⚠ Could not commit auto-fixes: ${e.message}`);
    }
  }

  // Build detailed summary with error counts, using actual tool names from results
  const appliedTools = results
    .filter((r) => r.ok)
    .map((r) => r.tool);
  const fixedLint = results.some((r) => r.tool && r.tool.includes('eslint') && r.ok);
  const fixedImports = results.some((r) => r.tool && r.tool.includes('prettier') && r.ok);

  let summary = appliedTools.length > 0
    ? appliedTools.join(' + ')
    : 'no auto-fixes applied';

  if (errorsBefore !== null || errorsAfter !== null) {
    const before = errorsBefore !== null ? errorsBefore : '?';
    const after = errorsAfter !== null ? errorsAfter : '?';
    summary += ` (errors: ${before} → ${after})`;
  }

  return {
    ok: true,
    fixed,
    fixedLint,
    fixedImports,
    summary,
    committed,
    errorsBefore,
    errorsAfter,
    errorsFixed
  };
}
