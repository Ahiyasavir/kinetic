/**
 * shared/types.mjs — universal type contracts for the autopilot engine.
 *
 * These are the stable interfaces that both the core engine and any plugin must conform to.
 * They contain no project-specific logic and can be imported safely from core/, lib/, or plugins/.
 *
 * Exported as JSDoc-annotated constants so the contracts are readable and IDE-discoverable without
 * requiring a TypeScript build step.
 */

/**
 * The interface a context-provider plugin must implement.
 * Register via config.json → contextProvider.source.
 *
 * @typedef {Object} ContextProviderInterface
 * @property {function(): Promise<FileIndexMap>}       getFileIndex
 * @property {function(): Promise<SymbolIndexMap>}     getSymbolIndex
 * @property {function(): Promise<DependencyGraph>}    getDependencyGraph
 * @property {function(): Promise<boolean>}            isFresh
 */

/**
 * @typedef {Object} FileIndexMap
 * @property {string}   path        - relative path from repo root
 * @property {number}   size        - file size in bytes
 * @property {string}   hash        - SHA-1 content hash
 * @property {string[]} symbols     - top-level exported symbol names
 */

/**
 * @typedef {Object} SymbolIndexMap
 * @property {string} name     - symbol name
 * @property {string} file     - file it is defined in (relative)
 * @property {string} kind     - 'function' | 'class' | 'const' | 'type'
 */

/**
 * @typedef {Object} DependencyGraph
 * @property {Record<string, string[]>} imports - file → list of files it imports
 */

/**
 * TaskClass enum values (matches lib/task-class.mjs).
 * @enum {string}
 */
export const TASK_CLASS = Object.freeze({
  PRODUCT:     'product',
  ENGINE:      'engine',
  MAINTENANCE: 'maintenance',
  MIGRATION:   'migration',
});

/**
 * ProviderType enum values (matches lib/providers/).
 * @enum {string}
 */
export const PROVIDER_TYPE = Object.freeze({
  CLAUDE:      'claude',
  OPENROUTER:  'openrouter',
  CUSTOM:      'custom',
});
