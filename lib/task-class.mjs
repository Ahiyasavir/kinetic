// task-class.mjs — single source of truth for a task's CLASS and the selection/review policy that
// class implies. This is the primitive that fixes the core deadlock: the engine's own source lives in
// the gitignored /autopilot/ tree, so engine/internal work produces NO git diff and can never satisfy a
// product-delivery (player-visible-UI) review gate. Classifying tasks lets the reviewer apply the RIGHT
// gate per class (product → visible-change gate; engine/maintenance/migration → on-disk EVIDENCE gate)
// instead of forcing everything through the product gate.
//
// Pure + config-driven. `config.taskClasses` may override the goal→class map and per-class policy; with
// no config the DEFAULTS below apply, which preserve today's behavior for product tasks (they still get
// the product gate) and ONLY relax it for clearly engine/internal work.

export const CLASSES = Object.freeze(['product', 'engine', 'maintenance', 'migration']);

// Default goal/title-prefix → class map. Title prefixes (e.g. "architecture:", "product:") are the most
// reliable signal because inbox tasks often carry goal:'user' or goal:'structure' regardless of intent.
const DEFAULT_MAP = Object.freeze({
  // product — must produce a player- or admin-visible change
  product: 'product', ui: 'product', gameplay: 'product', admin: 'product',
  access: 'product', stations: 'product', builder: 'product', review: 'product', social: 'product',
  // engine/internal — the kinetic's own machinery (gitignored; judged by on-disk evidence)
  architecture: 'engine', structure: 'engine', engine: 'engine',
  intelligence: 'engine', optimization: 'engine', infra: 'engine',
  // maintenance — tidy/fix without a feature change
  reliability: 'maintenance', chore: 'maintenance', cleanup: 'maintenance',
  maintenance: 'maintenance', docs: 'maintenance', test: 'maintenance',
  // migration — schema/data moves that must preserve/transform existing state
  migration: 'migration', schema: 'migration',
});

// Per-class review/selection policy.
//   productGate      — require a player/admin-visible change verified against the git diff
//   evidence         — what counts as proof of completion: 'product-visible' | 'wiring' | 'artifact' | 'artifact+schema'
//   gitDiffRequired  — whether a non-empty git diff is mandatory (FALSE for gitignored engine work)
//   allowGitignored  — accept on-disk evidence outside git as valid (engine self-mods)
const DEFAULT_POLICY = Object.freeze({
  product:     { productGate: true,  evidence: 'product-visible',  gitDiffRequired: true,  allowGitignored: false },
  engine:      { productGate: false, evidence: 'wiring',           gitDiffRequired: false, allowGitignored: true  },
  maintenance: { productGate: false, evidence: 'artifact',         gitDiffRequired: false, allowGitignored: true  },
  migration:   { productGate: false, evidence: 'artifact+schema',  gitDiffRequired: false, allowGitignored: true  },
});

function titlePrefix(title) {
  const m = /^\s*([a-z][a-z0-9_-]*)\s*:/i.exec(String(title || ''));
  return m ? m[1].toLowerCase() : null;
}

// Classify a task → one of CLASSES.
// Precedence: explicit task.class → (goal if engine/maintenance/migration) → title prefix → goal → default.
//
// WHY goal is checked before title prefix for non-product goals:
//   The Architect and inbox parser set `goal` explicitly (e.g. goal:'architecture'). Title prefixes
//   are a convenience label that is often wrong — e.g. the Architect labels tasks "product: build X"
//   even when goal:'architecture' is set, because the description *sounds* like a product feature.
//   Trusting a "product:" prefix over an explicit goal:'architecture' causes engine tasks to get
//   stuck on the product delivery gate they can never satisfy. The fix: if the explicit goal field
//   already resolves to a non-product class, use it — only fall back to the title prefix when the
//   goal is absent, unknown, or itself maps to 'product'.
export function classifyTask(task, config) {
  const map = { ...DEFAULT_MAP, ...((config && config.taskClasses && config.taskClasses.map) || {}) };
  if (task && CLASSES.includes(task.class)) return task.class;             // explicit override wins

  const title = (task && task.title) || '';
  // strong keyword signals in the title body
  if (/\bmigrat(e|ion)\b|schema (migration|change)|data migration/i.test(title)) return 'migration';

  // If the goal field resolves to a non-product class, trust it — it was set deliberately and is
  // more reliable than a title prefix that may say "product:" for engine work.
  const goal = task && task.goal;
  const goalClass = goal && map[goal];
  if (goalClass && goalClass !== 'product') return goalClass;

  // Title prefix as tiebreaker (catches "architecture: …", "ui: …", etc. in titles where goal
  // is absent or unspecific like goal:'user').
  const pfx = titlePrefix(title);
  if (pfx && map[pfx]) return map[pfx];

  // Goal that maps to 'product', or unknown goal → fall through to default.
  if (goalClass) return goalClass;

  // Unknown → 'product' (safe default: preserves today's product-gate behavior; never silently
  // relaxes the gate for something we couldn't classify).
  return (config && config.taskClasses && config.taskClasses.default) || 'product';
}

export function reviewPolicy(cls, config) {
  const overrides = (config && config.taskClasses && config.taskClasses.policy) || {};
  const base = DEFAULT_POLICY[cls] || DEFAULT_POLICY.product;
  return { class: cls, ...base, ...(overrides[cls] || {}) };
}

// Selection policy hints (kept small; the selector already forces user tasks first). The key flag is
// `requiresProductDiff` — used by the structural-impossibility guard so an engine task is never spun
// against a gate it cannot satisfy.
export function selectionPolicy(cls, config) {
  const p = reviewPolicy(cls, config);
  return { class: cls, requiresProductDiff: !!p.productGate && !!p.gitDiffRequired, allowGitignored: !!p.allowGitignored };
}

export const _DEFAULTS = { DEFAULT_MAP, DEFAULT_POLICY };
