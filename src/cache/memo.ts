/**
 * `createTtlMemo` — memoise a keyed async load for `ttlMs`, single-flight.
 *
 * Use this instead of a `Map<key, { at, value }>`. Every hand-rolled one wrote
 * its entry AFTER the await, so N concurrent callers all missed and the cache
 * only ever helped the caller after them. This is `CacheEngine.prefetch` over
 * the memory adapter: concurrent misses share one load, a thrown load caches
 * nothing, and a `null` result is an answer.
 *
 * `invalidate` is FENCED by a generation in the slot key: a load already in flight writes to the
 * superseded slot, which nothing reads, so it can never repopulate the memo after an invalidation
 * — and a `get` after the invalidation never joins that load either.
 */

import { CacheEngine } from './engine.js';
import { createMemoryCacheAdapter } from './memory-adapter.js';
import type { ResolvedCacheOptions } from './options.js';

export interface TtlMemoOptions<K> {
  /** Freshness window. `0` disables memoisation — every call loads. */
  readonly ttlMs: number;
  /**
   * Key derivation. REQUIRED for non-primitive keys: an object key would be
   * identity-compared, never hit, and read as a caching bug. Fold anything that
   * changes the answer into it (a revision counter, a tenant).
   */
  readonly keyOf?: (key: K) => string;
  /** LRU ceiling. Default 10,000. */
  readonly maxEntries?: number;
}

export interface TtlMemo<K, V> {
  get(key: K): Promise<V>;
  /** Drop one key, or everything. */
  invalidate(key?: K): Promise<void>;
}

const PREFIX = 'memo';

export function createTtlMemo<K, V>(
  load: (key: K) => Promise<V>,
  options: TtlMemoOptions<K>,
): TtlMemo<K, V> {
  const { ttlMs, keyOf, maxEntries } = options;
  const adapter = createMemoryCacheAdapter({ maxEntries: maxEntries ?? 10_000 });
  const engine = new CacheEngine(adapter, { prefix: PREFIX });
  const resolved: ResolvedCacheOptions = {
    staleTime: Math.max(0, ttlMs) / 1000,
    gcTime: 0,
    tags: [],
    bypass: false,
    swr: false,
    enabled: ttlMs > 0,
  };

  const limit = maxEntries ?? 10_000;
  /** Bumped by a full `invalidate()`; per-key generations exist only for keys invalidated since. */
  let epoch = 0;
  const generations = new Map<string, number>();
  const slot = (base: string): string => `${base}#${epoch}.${generations.get(base) ?? 0}`;

  const toKey = (key: K): string => {
    if (keyOf) return `${PREFIX}:${keyOf(key)}`;
    const t = typeof key;
    if (t === 'string' || t === 'number' || t === 'boolean') return `${PREFIX}:${String(key)}`;
    throw new TypeError(
      `createTtlMemo: a ${key === null ? 'null' : t} key needs keyOf(...) — an identity-compared key never hits`,
    );
  };

  return {
    get(key: K): Promise<V> {
      return engine.prefetch<V>(slot(toKey(key)), resolved, () => load(key));
    },
    async invalidate(key?: K): Promise<void> {
      if (key === undefined || generations.size >= limit) {
        epoch += 1;
        generations.clear();
        await engine.clear();
        return;
      }
      const base = toKey(key);
      const superseded = slot(base);
      generations.set(base, (generations.get(base) ?? 0) + 1);
      await adapter.delete(superseded);
    },
  };
}
