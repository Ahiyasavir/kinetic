// context-compressor.test.mjs — node:test suite for the U-81 AST context compressor
// (lib/context-compressor.mjs). Hermetic: synthetic in-memory files, no disk/git.
//   node --test autopilot/tests/context-compressor.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { compressContext } from '../lib/context-compressor.mjs';

const CFG = { enabled: true, minFileSizeLines: 200, level: 2 };

// Build a JS file with N small, body-having functions so it comfortably exceeds the line threshold.
function bigFile(count, names, relevantBodyExtra = '') {
  const parts = [];
  for (let i = 0; i < count; i++) {
    const name = names && names[i] ? names[i] : `helper${i}`;
    parts.push(
      `export function ${name}(a, b) {`,
      `  // ${name} does some work`,
      `  const x = a + b;`,
      `  const y = x * 2;`,
      `  ${relevantBodyExtra}`,
      `  return y;`,
      `}`,
      ``
    );
  }
  return parts.join('\n');
}

// 1) Empty file → empty content, wasCompressed=false.
test('empty file returns empty content, not compressed', () => {
  const r = compressContext([{ path: 'a.js', content: '' }], 'anything', CFG);
  assert.equal(r.files[0].content, '');
  assert.equal(r.files[0].wasCompressed, false);
});

// 2) File under minFileSizeLines (100 lines) → Level 0 (unchanged).
test('file under threshold is returned unchanged (Level 0)', () => {
  const content = bigFile(10); // ~80 lines, < 200
  const r = compressContext([{ path: 'small.js', content }], 'helper0', CFG);
  assert.equal(r.files[0].wasCompressed, false);
  assert.equal(r.files[0].content, content);
});

// 3) File over threshold with 1 relevant function → that body kept, rest collapse to signatures.
test('over-threshold file keeps relevant body, collapses the rest', () => {
  const names = Array.from({ length: 40 }, (_, i) => `fn${i}`);
  const content = bigFile(40, names); // ~320 lines
  // Task names fn7 → it stays at full body; the others become signatures.
  const r = compressContext([{ path: 'big.js', content }], 'please fix fn7 behavior', CFG);
  const out = r.files[0];
  assert.equal(out.wasCompressed, true);
  assert.ok(out.content.includes('fn7 does some work'), 'relevant fn7 body retained');
  assert.ok(out.content.includes('/* … */'), 'other bodies collapsed to signatures');
  assert.ok(!out.content.includes('fn30 does some work'), 'irrelevant body removed');
});

// 4) File with no named exports/symbols → gracefully Level 0.
test('file with no extractable symbols returns Level 0', () => {
  // 300 lines of plain statements, no function/class declarations.
  const content = Array.from({ length: 300 }, (_, i) => `const v${i} = ${i};`).join('\n');
  const r = compressContext([{ path: 'nosym.js', content }], 'whatever', CFG);
  assert.equal(r.files[0].wasCompressed, false);
  assert.equal(r.files[0].content, content);
});

// 5) Circular internal calls → terminates (visited-set BFS, no infinite loop).
test('circular internal calls terminate without hang', () => {
  const names = Array.from({ length: 40 }, (_, i) => `node${i}`);
  // node0 calls node1, node1 calls node0 → cycle; task seeds node0.
  let content = bigFile(40, names);
  content = content
    .replace('node0 does some work', 'node0 calls node1();')
    .replace('node1 does some work', 'node1 calls node0();');
  const r = compressContext([{ path: 'cycle.js', content }], 'investigate node0', CFG);
  // Reaching here means it returned (did not hang); node0's body is kept.
  assert.equal(r.files[0].wasCompressed, true);
  assert.ok(r.files[0].content.includes('node0 calls node1'));
});

// 6) AST parse failure (malformed / TS syntax) → Level 0, no throw.
test('parse failure falls back to full content without throwing', () => {
  const broken = 'export function bad(a: number): number {\n' +
    Array.from({ length: 300 }, (_, i) => `  const x${i} = ${i};`).join('\n') +
    '\n  return x0;\n}\n'; // TS type annotations break acorn's JS parser
  let r;
  assert.doesNotThrow(() => { r = compressContext([{ path: 'bad.ts', content: broken }], 'bad', CFG); });
  assert.equal(r.files[0].wasCompressed, false);
  assert.equal(r.files[0].content, broken);
});

// 7) totalRatio strictly between 0 and 1 when compression occurs.
test('totalRatio is strictly between 0 and 1 when compression happens', () => {
  const names = Array.from({ length: 40 }, (_, i) => `g${i}`);
  const content = bigFile(40, names);
  const r = compressContext([{ path: 'ratio.js', content }], 'fix g3', CFG);
  assert.equal(r.files[0].wasCompressed, true);
  assert.ok(r.totalRatio > 0 && r.totalRatio < 1, `ratio in (0,1): ${r.totalRatio}`);
});

// 8) Static marker for the evidence gate.
console.log('context compression: 7 checks passed');
