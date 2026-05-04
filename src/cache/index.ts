/**
 * Public entry for the `cache` subpath.
 *
 * The unified cache layer for the @classytic ecosystem — one shape,
 * one plugin, one engine. Mongokit / sqlitekit / future kits compose
 * this into their `Repository`; arc forwards declarative `cache:`
 * config into the same per-call options bag; Express/Nest hosts call
 * the plugin directly.
 *
 * **TanStack Query-shaped per-call options:**
 *   - `staleTime` — fresh window (seconds)
 *   - `gcTime`    — retention past fresh (seconds)
 *   - `swr`       — serve-stale + background refresh
 *   - `tags`      — group invalidation
 *   - `bypass`    — force fresh fetch + write
 *   - `enabled`   — skip cache entirely
 *   - `key`       — explicit key override
 *
 * **Production guarantees:**
 *   - Single-flight on miss (no cache stampede)
 *   - Per-scope version-bump (writes don't invalidate other tenants)
 *   - Cross-runtime SWR scheduling (Node `setImmediate`, edge `setTimeout(0)`)
 *   - TTL-bounded tag side-index (no unbounded growth)
 *   - Strictly-monotonic version values (no same-ms collisions)
 *   - Allowlist-per-op shape keys (only result-affecting fields hashed)
 *   - Atomic adapter primitives (`addToSet`, `increment`) for multi-pod safety
 *
 * **What this barrel exports.** STABLE public API only — host-facing
 * symbols every consumer needs (adapter contract, plugin factory,
 * engine direct API, decorators). Internal helpers (key derivation,
 * tag-index plumbing, envelope shape, scope extraction, version-store
 * primitives, stable-stringify) live in sibling modules and are
 * reachable via deep imports for advanced use cases (`@classytic/repo-core/cache/keys`,
 * `.../envelope`, etc.) but are NOT part of the stable contract.
 *
 * Plug it in via `repo.use(cachePlugin({ adapter }))` AFTER your
 * tenant / soft-delete / policy plugins so their filter mutations
 * land in the cache key.
 */

// ── Engine — direct API for action results / custom routes ───────────
export { CacheEngine, type CacheEngineOptions, type SingleFlightClaim } from './engine.js';
export { createMemoryCacheAdapter } from './memory-adapter.js';

// ── Per-call options + result envelope ───────────────────────────────
export type { CacheOptions, CacheReadResult } from './options.js';
// ── Plugin — canonical hook integration kits and arc compose ─────────
export {
  cachePlugin,
  DEFAULT_CACHEABLE_OPS,
  DEFAULT_INVALIDATING_OPS,
  DEFAULT_SHAPE_KEYS_BY_OP,
  type LogCallbacks,
  type RepositoryCacheHandle,
  type RepositoryCachePluginOptions,
} from './plugin/index.js';
export { scheduleBackground } from './runtime.js';

// ── Adapter decorators + runtime utilities ───────────────────────────
export { CacheTimeoutError, type TimeoutAdapterOptions, withTimeout } from './timeout-adapter.js';
// ── Adapter contract + reference impl ────────────────────────────────
export type { CacheAdapter } from './types.js';
