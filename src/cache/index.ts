/**
 * Public entry for the `cache` subpath.
 *
 * Portable cache primitives every kit composes into its own `cachePlugin`.
 * Repo-core ships the type contract + two helpers (stable key hashing +
 * in-memory reference adapter) so kit implementations stay consistent
 * without duplicating the infrastructure.
 */

export { createMemoryCacheAdapter } from './memory-adapter.js';
export { stableStringify } from './stable-stringify.js';
export type { CacheAdapter } from './types.js';
