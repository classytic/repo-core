/**
 * Typed accessors for the shared hook-context bag.
 *
 * The plugin coordinates between `before:<op>` and `after:<op>` /
 * `error:<op>` hooks via slots stamped on the context object. Without
 * a typed surface, every access is a `context["_cacheKey"]` bracket
 * lookup with no type-safety on the slot name.
 *
 * `ctx(rawContext)` casts the bag to a typed view exposing exactly
 * the slots the plugin reads/writes. One cast per hook entry; the
 * rest of the body uses dotted access.
 */

import type { CacheOptions, ResolvedCacheOptions } from '../options.js';

/**
 * Internal slots the plugin stamps onto the hook context. All
 * underscore-prefixed so they don't collide with kit / host fields.
 */
export interface CacheContextSlots {
  /** The cache key the plugin computed in `before:<op>`. */
  _cacheKey?: string;
  /** Resolved options (after defaults merge) used for set + tag-index. */
  _cacheResolved?: ResolvedCacheOptions;
  /** `true` when the kit should short-circuit via `_cachedValue<T>`. */
  _cacheHit?: boolean;
  /** The cached payload (set when `_cacheHit === true`). */
  _cachedResult?: unknown;
  /** Freshness state of the hit — `'fresh'` or `'stale'`. */
  _cacheStatus?: 'fresh' | 'stale';
  /**
   * `true` when the hit came from a coalesced single-flight wait
   * (NOT from the cache layer itself). Suppresses the after-hook's
   * cache-write since another caller is responsible.
   */
  _cacheCoalesced?: boolean;
}

/**
 * Generic context shape — the open bag every kit feeds into hooks.
 * The intersection with `CacheContextSlots` lets the plugin's typed
 * accesses coexist with the kit's own context fields.
 */
export type AnyContext = Record<string, unknown> & CacheContextSlots;

/**
 * Cast a raw hook context into the typed slots view. One call per
 * hook entry; subsequent slot reads/writes use plain dotted access.
 */
export function ctx(raw: unknown): AnyContext {
  return raw as AnyContext;
}

// ──────────────────────────────────────────────────────────────────────
// Shape-key allowlist — per-op fields that affect result shape
// ──────────────────────────────────────────────────────────────────────

/**
 * Default per-op allowlist of context fields that affect result shape
 * (and therefore must participate in the cache key). Hosts can extend
 * via `cachePlugin({ shapeKeysByOp })`.
 *
 * **Allowlist beats denylist** because:
 *   - New context fields don't silently slip into the cache key (which
 *     would explode the miss rate when ANY non-shape field varies
 *     per request — request IDs, trace headers, timestamps).
 *   - New ops require explicit registration (forces thinking about
 *     what affects shape).
 *   - Hosts can override per-kit when their kit accepts a non-standard
 *     option (e.g. mongoose's `lean`, prisma's `select` shape, etc.).
 */
export const DEFAULT_SHAPE_KEYS_BY_OP: Readonly<Record<string, readonly string[]>> = Object.freeze({
  // Filter-shaped reads
  getById: ['id', 'lean', 'select', 'populate', 'populateOptions'],
  getOne: ['filter', 'select', 'populate', 'populateOptions', 'lean'],
  getByQuery: ['query', 'select', 'populate', 'populateOptions', 'lean'],
  getAll: [
    'filter',
    'filters',
    'sort',
    'select',
    'populate',
    'populateOptions',
    'lean',
    'page',
    'limit',
    'after',
  ],
  // Filter-shaped scalars
  count: ['filter', 'filters'],
  exists: ['filter', 'filters'],
  distinct: ['filter', 'filters', 'field'],
  // Aggregate IR — `aggRequest` is the entire request shape; the cache
  // key strips operational slots (`cache`, `executionHints`) inside.
  aggregate: ['aggRequest'],
  aggregatePaginate: ['aggRequest'],
});

/**
 * Pick the shape-affecting fields from a context for the given op.
 * Returns `undefined` when no shape keys are registered for the op or
 * none of them have values — the caller then keys solely on op + model.
 *
 * Aggregate ops get their `aggRequest` field auto-stripped of
 * operational slots (`cache`, `executionHints`) before hashing —
 * those don't affect the result, only HOW the call runs. Without
 * stripping, `bypass: true` and `bypass: false` would produce
 * different keys, defeating the "bypass overwrites cache" semantic.
 */
export function extractShapeFields(
  context: AnyContext,
  op: string,
  shapeKeysByOp: Readonly<Record<string, readonly string[]>>,
): Record<string, unknown> | undefined {
  const keys = shapeKeysByOp[op];
  if (!keys || keys.length === 0) return undefined;
  const isAggregate = AGGREGATE_OPS.has(op);
  const out: Record<string, unknown> = {};
  for (const k of keys) {
    const v = context[k];
    if (v === undefined) continue;
    out[k] = isAggregate && k === 'aggRequest' ? stripAggOperationalSlots(v) : v;
  }
  return Object.keys(out).length > 0 ? out : undefined;
}

/**
 * Strip operational slots from an `AggRequest` before hashing.
 * `cache` and `executionHints` describe HOW the call runs, not WHAT
 * it computes — including them in the key would cause spurious
 * misses on per-call config tweaks.
 */
function stripAggOperationalSlots(value: unknown): unknown {
  if (!value || typeof value !== 'object') return value;
  const { cache: _c, executionHints: _eh, ...rest } = value as Record<string, unknown>;
  void _c;
  void _eh;
  return rest;
}

// ──────────────────────────────────────────────────────────────────────
// Per-call cache option extraction
// ──────────────────────────────────────────────────────────────────────

/** Aggregate ops carry their cache slot inside the AggRequest IR. */
export const AGGREGATE_OPS: ReadonlySet<string> = new Set(['aggregate', 'aggregatePaginate']);

/**
 * Extract per-call `CacheOptions` from a hook context. Three valid
 * locations covered (kit-dependent):
 *   1. Aggregate ops: `context.aggRequest.cache`
 *   2. CRUD with merged options: `context.cache` (mongokit spreads)
 *   3. CRUD with options bag: `context.options.cache` (sqlitekit-style)
 *
 * Returns `undefined` when no per-call options are set; caller falls
 * back to plugin defaults / per-op defaults.
 */
export function extractCallCacheOptions(context: AnyContext, op: string): CacheOptions | undefined {
  if (AGGREGATE_OPS.has(op)) {
    const aggReq = context['aggRequest'] as { cache?: CacheOptions } | undefined;
    return aggReq?.cache;
  }
  const direct = context['cache'];
  if (direct && typeof direct === 'object') return direct as CacheOptions;
  const options = context['options'] as Record<string, unknown> | undefined;
  const inOptions = options?.['cache'];
  if (inOptions && typeof inOptions === 'object') return inOptions as CacheOptions;
  return undefined;
}
