// doc-index.mjs — parse CLAUDE.md, TECH_SPEC.md, STRUCTURE.md and extract all referenced file paths.

// Regex to extract file/path references from backtick code spans, table cells, and inline text.
// Matches things like `functions/src/index.ts`, paths in table columns, etc.
const PATH_RE = /[`|]?\s*((?:[\w.-]+\/)+[\w.-]+\.\w+)\s*[`|]?/g;

function extractPathsFromContent(content) {
  const paths = [];
  const seen = new Set();
  let m;
  // Reset lastIndex before using the regex.
  PATH_RE.lastIndex = 0;
  while ((m = PATH_RE.exec(content)) !== null) {
    const p = m[1].trim();
    if (p && !seen.has(p)) {
      seen.add(p);
      paths.push(p);
    }
  }
  return paths;
}

// Reconstruct full file paths from an ASCII tree diagram (├──/└── art) by tracking
// indentation depth. Works for the trees in STRUCTURE.md *and* the directory maps inside
// CLAUDE.md / TECH_SPEC.md. Only LEAF FILE paths (last segment has an extension) are
// returned — directory nodes and bare single-segment names are deliberately excluded so
// downstream substring matching can't over-suppress warnings (a bare "src" token would
// otherwise match every architecture file and silence every drift warning).
function extractTreePaths(content) {
  const paths = [];
  const seen = new Set();
  const lines = content.split(/\r?\n/);
  const stack = []; // node names indexed by depth, for path reconstruction

  for (const line of lines) {
    // Detect tree-art lines (allow │ and spaces in the indent gutter).
    const treeMatch = /^([│ ]*)[├└]──\s+(.+)/.exec(line);
    if (!treeMatch) continue;

    const indent = treeMatch[1].length;
    // Trees align a status/comment column after 2+ spaces (e.g. "src/index.ts   ✅  30 callables"
    // or "index.ts            # 33 callables"). Keep only the node name; drop the trailing
    // description so reconstructed paths stay clean.
    const name = treeMatch[2].trim().split(/\s{2,}|\s+#/)[0].trim().replace(/[/\\]+$/, '');
    if (!name) continue;

    // Depth is indent / 4 (tree-art uses a 4-char "│   " gutter per nesting level).
    const depth = Math.floor(indent / 4);

    // Place this node at its depth and discard anything deeper (robust to skipped levels).
    stack[depth] = name;
    stack.length = depth + 1;

    // Keep only leaf files (last segment looks like "name.ext"); skip directory nodes.
    if (!/\.[\w]+$/.test(name)) continue;

    const reconstructed = stack.join('/');
    if (!seen.has(reconstructed)) {
      seen.add(reconstructed);
      paths.push(reconstructed);
    }
  }
  return paths;
}

/**
 * Parse a map of { docName: content } and return a unified reference index.
 * @param {{ [docName: string]: string }} docsMap
 * @returns {{
 *   referencedFiles: string[],
 *   claudeReferences: string[],
 *   techSpecReferences: string[],
 *   structureReferences: string[],
 *   referencedPaths: string[]
 * }}
 */
export function parseDocIndex(docsMap) {
  const claudeReferences = [];
  const techSpecReferences = [];
  const structureReferences = [];
  const referencedPaths = [];

  if (!docsMap || typeof docsMap !== 'object') {
    return { referencedFiles: [], claudeReferences, techSpecReferences, structureReferences, referencedPaths };
  }

  for (const [docName, content] of Object.entries(docsMap)) {
    if (!content) continue;
    const paths = extractPathsFromContent(content);

    if (docName === 'CLAUDE.md') {
      claudeReferences.push(...paths);
    } else if (docName === 'TECH_SPEC.md') {
      techSpecReferences.push(...paths);
    } else if (docName === 'STRUCTURE.md') {
      structureReferences.push(...paths);
    }

    // Every doc may carry an ASCII directory tree; reconstruct leaf-file paths from all of them.
    referencedPaths.push(...extractTreePaths(content));
  }

  // Combine all into referencedFiles (deduped).
  const all = new Set([...claudeReferences, ...techSpecReferences, ...structureReferences]);
  const referencedFiles = [...all];

  return { referencedFiles, claudeReferences, techSpecReferences, structureReferences, referencedPaths };
}
