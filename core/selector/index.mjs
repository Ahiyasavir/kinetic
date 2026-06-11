// core/selector/index.mjs — the generic SELECT workflow.
//
// Runs the `selector` role and returns its parsed handoff (`selection.json`). This module is
// deliberately project-agnostic: the candidate ranking / task-scoring model is computed by the host
// (supervisor.mjs uses lib/score.mjs) and passed in entirely through `vars` (CANDIDATES, DONE,
// BLOCKED, NEXT_ID, WEAK_BACKLOG, HANDOFF_PATH …). The core only invokes the role and reads the result,
// so a different host can plug in its own scoring without touching this file.
//
// Optional context-map seam (U-37): a host may pass `{ contextMaps }` (or a `contextProvider`) so the
// selector reuses a pre-computed codebase map (file/symbol/dependency index) supplied by an external
// app instead of re-deriving it from a local scan. When valid+fresh maps are available they are
// injected into the prompt vars (CONTEXT_MAPS/CONTEXT_SOURCE); when absent/stale/invalid the selector
// silently falls back to its existing local analysis — backward compatible, never an error.

import { loadContextMaps, summarizeContextMaps } from '../context-provider.mjs';
import { getRelevantFiles } from '../dependencies.mjs';

export const HANDOFF_FILE = 'selection.json';

/**
 * @param {{invokeRole:Function, readHandoff:Function}} runner  from createRoleRunner()/createCore()
 * @param {object} vars   prompt template variables (host builds these from its scoring model)
 * @param {string} [model] optional model override
 * @param {{
 *   contextMaps?: object,
 *   contextProvider?: (object|Function),
 *   validateFreshness?: boolean,
 *   maxStaleMs?: number,
 *   cacheStrategy?: string,
 *   disableDependencyOptimization?: boolean,
 *   profileSelectorTokens?: boolean,
 * }} [opts]
 *   optional seam — context-provider maps (U-37) and dependency optimization (U-45).
 * @returns parsed selection handoff (or null)
 */
export async function runSelector(runner, vars, model, opts = {}) {
  const enriched = { ...vars };

  // Prefer external, provider-supplied context maps over local analysis when they're valid + fresh.
  if (opts.contextMaps || opts.contextProvider) {
    const ctx = await loadContextMaps({
      contextMaps: opts.contextMaps,
      provider: opts.contextProvider,
      validateFreshness: opts.validateFreshness,
      maxStaleMs: opts.maxStaleMs,
      cacheStrategy: opts.cacheStrategy
    });
    if (ctx.ok) {
      // U-45: filter context maps to only dependency-relevant files before summarising,
      // reducing the CONTEXT_MAPS token footprint when a large codebase index is provided.
      let mapsToSummarise = ctx.maps;
      if (!opts.disableDependencyOptimization &&
          ctx.maps.dependencyGraph && ctx.maps.fileIndex) {
        const depGraph = ctx.maps.dependencyGraph;
        const taskDesc = [vars.CANDIDATES || '', vars.WEAK_BACKLOG || ''].join(' ');
        const relevant = getRelevantFiles(null, taskDesc, depGraph, {
          depGraph,
          maxDepth: 3,
          maxFiles: 40,
        });
        const totalFiles = Object.keys(ctx.maps.fileIndex).length;
        if (relevant.length > 0 && relevant.length < totalFiles) {
          const filteredFileIndex = {};
          const filteredDepGraph = {};
          for (const f of relevant) {
            if (ctx.maps.fileIndex[f]) filteredFileIndex[f] = ctx.maps.fileIndex[f];
            if (ctx.maps.dependencyGraph[f]) filteredDepGraph[f] = ctx.maps.dependencyGraph[f];
          }
          mapsToSummarise = { ...ctx.maps, fileIndex: filteredFileIndex, dependencyGraph: filteredDepGraph };
          if (opts.profileSelectorTokens) {
            const pct = Math.round((1 - relevant.length / totalFiles) * 100);
            console.log(`[dep-opt] selector context: ${totalFiles} → ${relevant.length} files (${pct}% reduction)`);
          }
        }
      }
      enriched.CONTEXT_MAPS = JSON.stringify(summarizeContextMaps(mapsToSummarise));
      enriched.CONTEXT_SOURCE = ctx.source || '';
    }
    // ctx.ok === false → silently fall back to local analysis (no vars added; existing behavior).
  }

  await runner.invokeRole('selector', enriched, model);
  return runner.readHandoff(HANDOFF_FILE);
}
