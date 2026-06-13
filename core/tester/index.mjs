// core/tester/index.mjs — the generic TEST-GENERATION workflow.
//
// Runs the `tester` role to generate a test suite from the task specification and target files.
// The tester analyzes the task acceptance criteria, implementation hints, and relevant source files
// to produce a comprehensive test file that the implementer must pass before marking the task ready.
// This phase runs immediately after Selector (once a task is chosen) and before Implementer begins,
// establishing a quality gate at specification time rather than post-implementation.
//
// Runner detection (Cycle-212 fix): before generating the test file, the workspace's root
// package.json is inspected to identify the active test runner (jest / vitest / mocha / node).
// The result is injected as RUNNER_CONTEXT into the tester prompt so the LLM generates
// framework-correct imports and syntax instead of always defaulting to Jest.

import { readFileSync, existsSync } from 'node:fs';
import path from 'node:path';

export const HANDOFF_FILE = 'tester.json';

/**
 * Inspect the target workspace's package.json and return the active test runner.
 * Checks devDependencies, dependencies, and scripts.test in priority order.
 *
 * @param {string} repoRoot  absolute path to the target repository root
 * @returns {{ runner: string, framework: string|null, command: string }}
 */
export function detectTestRunner(repoRoot) {
  const pkgPath = path.join(repoRoot, 'package.json');
  if (!existsSync(pkgPath)) {
    return { runner: 'node', framework: null, command: 'node --test' };
  }
  let pkg;
  try {
    pkg = JSON.parse(readFileSync(pkgPath, 'utf8'));
  } catch {
    return { runner: 'node', framework: null, command: 'node --test' };
  }
  const allDeps = { ...(pkg.dependencies || {}), ...(pkg.devDependencies || {}) };
  const testScript = (pkg.scripts && pkg.scripts.test) || '';

  if (allDeps.vitest || /\bvitest\b/.test(testScript)) {
    return { runner: 'vitest', framework: 'vitest', command: 'npx vitest run' };
  }
  if (allDeps.jest || allDeps['@jest/globals'] || /\bjest\b/.test(testScript)) {
    return { runner: 'jest', framework: 'jest', command: 'npm test' };
  }
  if (allDeps.mocha || /\bmocha\b/.test(testScript)) {
    return { runner: 'mocha', framework: 'mocha', command: 'npx mocha' };
  }
  return { runner: 'node', framework: null, command: 'node --test' };
}

/**
 * Build the RUNNER_CONTEXT prompt block from detected runner info.
 * Injected into the tester prompt so the LLM uses the correct import style.
 *
 * @param {{ runner: string, framework: string|null, command: string }} info
 * @returns {string}
 */
export function buildRunnerContext(info) {
  const { runner, command } = info;
  if (runner === 'vitest') {
    return `**Detected test runner: Vitest**
Import from \`vitest\`, NOT \`@jest/globals\`. Run with: \`${command}\`
\`\`\`javascript
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
\`\`\``;
  }
  if (runner === 'jest') {
    return `**Detected test runner: Jest**
Import from \`@jest/globals\`. Run with: \`${command}\`
\`\`\`javascript
import { describe, it, expect, beforeEach, afterEach } from '@jest/globals';
\`\`\``;
  }
  if (runner === 'mocha') {
    return `**Detected test runner: Mocha**
Use Mocha globals (\`describe\`/\`it\` are injected) with \`node:assert/strict\` for assertions. Run with: \`${command}\`
\`\`\`javascript
import assert from 'node:assert/strict';
// describe and it are Mocha globals — no import needed
\`\`\``;
  }
  // Default: native Node.js test runner (node:test)
  return `**Detected test runner: Node.js built-in (node:test)**
No external test framework found. Use \`node:test\` and \`node:assert/strict\`. Run with: \`${command}\`
\`\`\`javascript
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
\`\`\``;
}

/**
 * @param {{invokeRole:Function, readHandoff:Function}} runner
 * @param {object} vars  prompt template variables (TASK_JSON, TARGET_FILES, HANDOFF_PATH, REPO_ROOT …)
 * @param {string} [model] model override for test generation
 * @returns parsed tester handoff (or null) — includes testFilePath + testContent + cost metadata
 */
export async function runTester(runner, vars, model) {
  const enriched = { ...vars };
  // Auto-inject RUNNER_CONTEXT when the caller supplies REPO_ROOT and hasn't already set it.
  if (!enriched.RUNNER_CONTEXT) {
    const repoRoot = enriched.REPO_ROOT || null;
    const info = repoRoot ? detectTestRunner(repoRoot) : { runner: 'node', framework: null, command: 'node --test' };
    enriched.RUNNER_CONTEXT = buildRunnerContext(info);
  }
  await runner.invokeRole('tester', enriched, model);
  return runner.readHandoff(HANDOFF_FILE);
}
