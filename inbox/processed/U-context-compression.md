optimization: AST-based context compression — extract only task-relevant symbols from large files before injecting into Implementer prompt; targets 40-60% token reduction on files over 200 lines
goal: optimization
risk: 4
effort: 4

## Background & Motivation

As the codebase grows, context injection becomes the dominant token cost. A task that modifies
one function in a 600-line file currently sends all 600 lines to the model. 80-90% of those tokens
are noise — they don't help the model and inflate cost. U-45 already built an AST dependency parser
(lib/context-compiler.mjs or similar). This task builds on it to compress file contents to only
what matters for the current task.

SAFE PRINCIPLE: If compression fails for any reason, silently fall back to full-file content.
A cycle must NEVER fail due to compression infrastructure errors.

---

## Compression Levels

Level 0 (no compression): full file content — current behavior, always the fallback.

Level 1 (signatures): all functions/classes → name + params + return annotation + 1-line comment.
  No function bodies.

Level 2 (focused — DEFAULT for files > minFileSizeLines):
  - All symbols → L1 representation
  - Task-relevant symbols (mentioned in task title/notes/acceptanceCriteria) → full body
  - Dep-graph symbols (callers/callees of task-relevant, within 1 hop) → full body
  - All other symbols → L1 only

Level 3 (surgical, optional):
  - Same as L2 but includes 2-hop dep-graph. Reserved for tasks with many cross-file dependencies.
  Currently do NOT implement L3 — stub it as a config option that falls back to L2.

---

## lib/context-compressor.mjs

New module. Exports:
```js
export function compressContext(files, taskDescription, config) {
  /**
   * @param files Array<{ path: string, content: string }>
   * @param taskDescription string — task title + notes concatenated (used for symbol relevance)
   * @param config object — config.contextCompression block
   * @returns { files: Array<{ path, content, wasCompressed, originalLines, compressedLines }>, totalRatio }
   * totalRatio = sum(compressedLines) / sum(originalLines)
   */
}
```

Integration point: called inside the Implementer's context assembly step, NOT as a separate
supervisor phase. Replace each file's `content` before building the Implementer prompt.
The original file on disk is NEVER touched.

---

## Relevance Detection

To find task-relevant symbols without a full semantic analysis:
1. Extract all function/class/export names from taskDescription via regex (word boundaries).
2. Parse the file with a lightweight AST walk (acorn or the parser already used by U-45).
3. A symbol is "relevant" if its name appears in taskDescription OR if it is called by a relevant
   symbol (1-hop BFS through the call graph within the same file).
4. On parse error (dynamic code, template literals in weird positions, TypeScript syntax):
   → catch the error, log it at debug level, return Level 0 (full content) for that file.

---

## Metrics Logging

After each cycle where compression ran, record in state.json under framework.usage:
```json
"lastCompressionStats": {
  "filesCompressed": N,
  "originalTokensEstimate": N,
  "compressedTokensEstimate": N,
  "totalRatio": 0.XX
}
```

Token estimate = character_count / 4 (rough approximation, sufficient for analytics).
This feeds U-65 (cost forecaster) and U-66 (cost analytics) when they ship.

---

## Config Scaffold

Add to autopilot/config.json:
```json
"contextCompression": {
  "enabled": false,
  "minFileSizeLines": 200,
  "level": 2,
  "_comment": "U-83 context compression — disabled by default; enable after testing with level:2"
}
```

Disabled by default. Reason: compression is a correctness-affecting operation. Enable after
verifying that compressed context does not degrade Implementer output quality on test tasks.

---

## Test Suite (node:test)

Create autopilot/tests/context-compressor.test.mjs (use node:test, NOT Jest):
1. Empty file → returns empty content, wasCompressed=false.
2. File under minFileSizeLines (100 lines) → Level 0 (no compression, wasCompressed=false).
3. File over threshold with 1 relevant function → that function at full body, rest at L1.
4. File with no named exports → gracefully returns Level 0 (no symbols to compress).
5. File with circular internal calls → terminates without infinite loop (BFS with visited set).
6. AST parse failure (malformed JS) → returns Level 0 content, no throw.
7. totalRatio is strictly between 0 and 1 when compression occurs.
8. Static marker: the test file must log 'context compression: 7 checks passed' (static string).

---

## Acceptance Criteria

1. `autopilot/lib/context-compressor.mjs` exists and exports `compressContext(files, taskDesc, config)`.
2. Files ≤ minFileSizeLines are returned unchanged (wasCompressed=false).
3. Files > threshold return compressed content with totalRatio < 1.
4. AST parse failure silently returns the original content (no throw, no cycle failure).
5. compressionStats logged to framework.usage after each compressed cycle.
6. Config `contextCompression.enabled: false` is the default — zero behavior change when disabled.
7. `lib/context-compressor.mjs` is imported in the Implementer prompt assembly path (not dead).
8. node:test suite at autopilot/tests/context-compressor.test.mjs covering the 8 cases above passes.
9. Static marker in lib/context-compressor.mjs: `// context compression: symbol-level extraction`

## Implementation Rules (MANDATORY — read before starting)

- This is an ENGINE task (class: engine). All files under autopilot/ (gitignored).
- Use node:test for the test suite (NOT Jest). Import: `import { test } from 'node:test'; import assert from 'node:assert'`
- lib/context-compressor.mjs MUST be imported by an existing module or new callee — not a dead file.
- supervisor.mjs IS editable (autopilot/core/.ready exists).
- Any verifyArtifact.contains must be a static string literal, never a template literal.
- Risk is 4 because AST parsing is fragile. Design defensively: every code path has a try/catch
  that returns Level 0. The engine must NEVER fail a cycle because of compression bugs.
