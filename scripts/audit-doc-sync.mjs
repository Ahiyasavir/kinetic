// audit-doc-sync.mjs — detect architecture-relevant file changes that are not mentioned in docs.
// Called post-validate, pre-cooldown; emits non-blocking warnings for user review.

import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { classifyArchitectureFiles } from './lib/arch-classifier.mjs';
import { parseDocIndex } from './lib/doc-index.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
// Default root for the in-place RushPoint layout (this engine lives in <repo>/autopilot/scripts).
// Callers in a multi-tenant / --workspace layout pass the real target-project root explicitly.
const DEFAULT_PROJECT_ROOT = path.resolve(__dirname, '..', '..');

const ALL_DOCS = ['CLAUDE.md', 'TECH_SPEC.md', 'STRUCTURE.md'];

// Priority order for doc suggestions based on the changed file's location.
function suggestDocsForFile(filePath) {
  const p = (filePath || '').replace(/\\/g, '/');
  if (p.startsWith('functions/')) return ['TECH_SPEC.md', 'CLAUDE.md', 'STRUCTURE.md'];
  if (p.startsWith('packages/shared/')) return ['TECH_SPEC.md', 'CLAUDE.md', 'STRUCTURE.md'];
  if (p.startsWith('apps/admin/')) return ['CLAUDE.md', 'TECH_SPEC.md', 'STRUCTURE.md'];
  if (p.startsWith('apps/mobile/')) return ['CLAUDE.md', 'TECH_SPEC.md', 'STRUCTURE.md'];
  return ['CLAUDE.md', 'TECH_SPEC.md', 'STRUCTURE.md'];
}

function loadProjectDocs(projectRoot) {
  const root = projectRoot || DEFAULT_PROJECT_ROOT;
  const docsMap = {};
  for (const doc of ALL_DOCS) {
    try {
      docsMap[doc] = readFileSync(path.join(root, doc), 'utf8');
    } catch {
      // Doc may not exist — treat as empty.
    }
  }
  return docsMap;
}

function isFileReferenced(filePath, docIndex) {
  if (!docIndex) return false;
  const p = (filePath || '').replace(/\\/g, '/');
  const pLower = p.toLowerCase();

  const allRefs = [
    ...(docIndex.referencedFiles || []),
    ...(docIndex.claudeReferences || []),
    ...(docIndex.techSpecReferences || []),
    ...(docIndex.structureReferences || []),
    // referencedPaths holds full paths reconstructed from the STRUCTURE.md tree (e.g. functions/src/index.ts)
    // which never appear as inline slash-paths — without these, documented tree files are false-flagged.
    ...(docIndex.referencedPaths || []),
  ];

  for (const ref of allRefs) {
    if (!ref) continue;
    const r = ref.replace(/\\/g, '/').trim();
    if (!r) continue;
    const rLower = r.toLowerCase();

    // Exact match (case-insensitive).
    if (rLower === pLower) return true;

    // Wildcard glob pattern (e.g. 'apps/*/src/'): prefix match up to the first '*'.
    if (r.includes('*')) {
      const prefix = rLower.split('*')[0];
      if (prefix && pLower.startsWith(prefix)) return true;
      continue;
    }

    // Only path-shaped refs (containing a '/') can match — boundary-aware, never a loose substring.
    // This lets a doc's relative ref ('routing/assignNextTask.ts') match the full changed path while
    // refusing to treat a NEW file under an already-documented directory as "documented".
    if (rLower.includes('/') && pLower.endsWith('/' + rLower)) return true;
    // Bare tokens (single directory/file names like 'routing' or 'src') are intentionally ignored:
    // matching them as substrings would mask brand-new modules that share a common segment name.
  }

  return false;
}

/**
 * Audit changed files against doc references. Returns an array of warning objects.
 *
 * @param {string[]|null|undefined} changedFiles - list of changed file paths
 * @param {object} [docIndex] - pre-parsed doc index (optional; loads from disk if omitted)
 * @param {string} [projectRoot] - target-project root to load docs from (defaults to the in-place layout)
 * @returns {Array<{ filePath: string, suggestedDocs: string[], matchedDocs: string[] }>}
 */
export function auditDocSync(changedFiles, docIndex, projectRoot) {
  if (!changedFiles || !Array.isArray(changedFiles) || changedFiles.length === 0) return [];

  // If no docIndex provided, load from disk.
  if (!docIndex) {
    const docsMap = loadProjectDocs(projectRoot);
    docIndex = parseDocIndex(docsMap);
  }

  const { architectureRelevant } = classifyArchitectureFiles(changedFiles);

  const warnings = [];
  const seen = new Set();

  for (const filePath of architectureRelevant) {
    if (seen.has(filePath)) continue;
    seen.add(filePath);

    if (isFileReferenced(filePath, docIndex)) continue;

    const suggestedDocs = suggestDocsForFile(filePath);
    warnings.push({ filePath, suggestedDocs, matchedDocs: [] });
  }

  return warnings;
}
