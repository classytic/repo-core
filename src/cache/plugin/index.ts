/**
 * Unified cache plugin — one `cachePlugin({ adapter, ... })` for every
 * kit + arc + Express/Nest hosts.
 *
 * Replaces:
 *   - mongokit's local `cachePlugin` (CRUD) + `aggregateCache`
 *     constructor option (aggregate)
 *   - sqlitekit's local `cachePlugin`
 *   - arc's per-route SWR wrap in `buildAggregationHandler`
 *
 * **Internal layout** (this module is the public-facing factory; the
 * machinery lives in sibling modules):
 *
 *   - `./context.ts`             — typed context slots + extraction
 *   - `./read-hooks.ts`          — before / after / error for read ops
 *                                   (cache check, single-flight, write)
 *   - `./invalidation-hooks.ts`  — after for write ops (per-scope bump
 *                                   + tag-side-index invalidation)
 *   - `./swr.ts`                 — background-refresh scheduler
 *
 * **Hook table:**
 *
 * | Phase   | Op                          | Action                                    |
 * |---------|-----------------------------|-------------------------------------------|
 * | before  | each op in `enabled`        | check cache; on hit, set `_cacheHit`;     |
 * |         |                             | on miss, claim or wait on single-flight   |
 * | after   | each op in `enabled`        | write fresh result + resolve waiters;     |
 * |         |                             | on stale hit, schedule SWR refresh        |
 * | error   | each op in `enabled`        | reject single-flight waiters fail-fast    |
 * | after   | each op in `invalidating`   | bump per-scope version + tag invalidate   |
 *
 * Hooks register at `HOOK_PRIORITY.CACHE` (= 200) so multi-tenant /
 * soft-delete plugins (POLICY = 100) run first — their filter
 * mutations land in the cache key, no cross-tenant cache poisoning.
 */

import type { RepositoryBase } from '../../repository/base.js';
import type { Plugin } from '../../repository/plugin-types.js';
import { CacheEngine } from '../engine.js';
import type { CacheOptions, CacheReadResult } from '../options.js';
import type { CacheAdapter } from '../types.js';
import { DEFAULT_SHAPE_KEYS_BY_OP } from './context.js';
import { registerInvalidationHooks } from './invalidation-hooks.js';
import { registerReadHooks } from './read-hooks.js';

/** Default read ops the plugin caches. Kits may override per resource. */
export const DEFAULT_CACHEABLE_OPS = [
  'getById',
  'getAll',
  'getOne',
  'getByQuery',
  'count',
  'exists',
  'distinct',
  'aggregate',
  'aggregatePaginate',
] as const;

/** Default mutating ops that bump version + invalidate tags on success. */
export const DEFAULT_INVALIDATING_OPS = [
  'create',
  'createMany',
  'update',
  'updateMany',
  'findOneAndUpdate',
  'upsert',
  'delete',
  'deleteMany',
  'restore',
  'claim',
  'claimVersion',
  'increment',
  'bulkWrite',
] as const;

/** Observability callbacks — pipe to metrics, traces, or stdout. */
export interface LogCallbacks {
  onHit?: (key: string, op: string, ageSeconds: number) => void;
  onStale?: (key: string, op: string, ageSeconds: number) => void;
  onMiss?: (key: string, op: string) => void;
  /**
   * Single-flight coalesce — the caller awaited an in-flight fetch
   * for the same key instead of running its own executor. High
   * coalesce rates indicate burst load on uncached entries — useful
   * signal for capacity planning + cache-warming.
   */
  onCoalesce?: (key: string, op: string) => void;
  onWrite?: (key: string, op: string, tags: readonly string[]) => void;
  onInvalidate?: (model: string, version: number, tagCount: number) => void;
}

export interface RepositoryCachePluginOptions {
  /** Concrete adapter — Redis, in-memory, custom KV. */
  readonly adapter: CacheAdapter;
  /** Read ops the plugin caches. Default: every op in `DEFAULT_CACHEABLE_OPS`. */
  readonly enabled?: readonly string[];
  /** Mutating ops that trigger invalidation. Default: every op in `DEFAULT_INVALIDATING_OPS`. */
  readonly invalidating?: readonly string[];
  /** Plugin-level defaults — applied to every call where the caller didn't override. */
  readonly defaults?: Partial<CacheOptions>;
  /** Per-op default overrides — `{ getById: { staleTime: 600 } }`. */
  readonly perOpDefaults?: Record<string, Partial<CacheOptions>>;
  /** Cache key namespace prefix. Default: `'rc'`. */
  readonly prefix?: string;
  /**
   * Auto-inject scope tags (`org:<id>`, `user:<id>`) extracted from
   * `context.filter`. Default: `true`. Disable when the host wires
   * scope manually via the `tags` option per-call.
   */
  readonly autoTagsFromScope?: boolean;
  /** TTL jitter — symmetric fractional or custom function. Default: `0`. */
  readonly jitter?: number | ((ttl: number) => number);
  /**
   * Per-op shape-key allowlist — overrides / extends defaults. Use
   * to register kit-specific shape-affecting fields (e.g. mongoose
   * `lean`, custom projection flags). Hosts merge with defaults via
   * standard object spread.
   *
   * @example
   * ```ts
   * cachePlugin({
   *   adapter,
   *   shapeKeysByOp: {
   *     ...DEFAULT_SHAPE_KEYS_BY_OP,
   *     getById: ['id', 'lean', 'select', 'myCustomFlag'],
   *   },
   * });
   * ```
   */
  readonly shapeKeysByOp?: Readonly<Record<string, readonly string[]>>;
  /** Observability callbacks. Each fires per cache event. */
  readonly log?: LogCallbacks;
}

/** Plugin-attached cache surface — exposed so kits can offer convenience methods. */
export interface RepositoryCacheHandle {
  readonly engine: CacheEngine;
  /** Invalidate every entry tagged with ANY of the provided tags. */
  invalidateByTags(tags: readonly string[]): Promise<number>;
  /** Bump the model's version — wipes every cached read for it. */
  bumpModelVersion(model: string): Promise<number>;
  /** Wipe the entire cache namespace (when the adapter supports it). */
  clear(): Promise<void>;
}

/**
 * Build the unified cache plugin. Compose alongside other plugins via
 * `repo.use(cachePlugin({ adapter }))` — install AFTER `multiTenant`
 * and `softDelete` so policy filters land in the cache key.
 */
export function cachePlugin(options: RepositoryCachePluginOptions): Plugin {
  const enabled = new Set(options.enabled ?? DEFAULT_CACHEABLE_OPS);
  const invalidating = new Set(options.invalidating ?? DEFAULT_INVALIDATING_OPS);
  const defaults = options.defaults;
  const perOpDefaults = options.perOpDefaults ?? {};
  const autoTagsFromScope = options.autoTagsFromScope ?? true;
  const log: LogCallbacks = options.log ?? {};
  const prefix = options.prefix ?? 'rc';
  const shapeKeysByOp = options.shapeKeysByOp ?? DEFAULT_SHAPE_KEYS_BY_OP;
  const engine = new CacheEngine(options.adapter, {
    prefix,
    ...(options.jitter !== undefined ? { jitter: options.jitter } : {}),
  });

  return {
    name: 'cache',
    apply(repo: RepositoryBase): void {
      // Expose the engine + helpers on the repo so kit-side methods
      // (e.g. mongokit's `invalidateAggregateCache`) can delegate.
      const handle: RepositoryCacheHandle = {
        engine,
        invalidateByTags: (tags) => engine.invalidateByTags(tags),
        bumpModelVersion: (model) => engine.bumpVersion(model),
        clear: () => engine.clear(),
      };
      (repo as RepositoryBase & { cache?: RepositoryCacheHandle }).cache = handle;

      for (const op of enabled) {
        registerReadHooks(repo, op, engine, {
          defaults,
          perOpDefaults: perOpDefaults[op],
          autoTagsFromScope,
          log,
          prefix,
          repo,
          shapeKeysByOp,
        });
      }

      for (const op of invalidating) {
        registerInvalidationHooks(repo, op, engine, { autoTagsFromScope, log });
      }
    },
  };
}

// Re-export shape-key defaults for hosts who want to extend rather than replace.
export { DEFAULT_SHAPE_KEYS_BY_OP } from './context.js';

export type { CacheReadResult };
