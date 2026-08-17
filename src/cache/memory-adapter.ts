/**
 * Reference in-memory adapter implementing `CacheAdapter`.
 *
 * Not for production scale — use Redis / KV / Memcached for real hosts.
 * Ships in repo-core because tests + single-process apps shouldn't each
 * reinvent the TTL + glob-invalidation logic, and the implementation is
 * genuinely driver-free.
 *
 * Bounded by default (`maxEntries`, LRU). A TTL alone does not bound a
 * cache — entries expire only when read, so a high-cardinality keyspace
 * grows until the process dies. Eviction is always safe for a cache, so
 * the bound is the default rather than an opt-in.
 */

import type { CacheAdapter } from './types.js';

export interface MemoryCacheAdapterOptions {
  /**
   * Hard entry ceiling; the least-recently-used entry is evicted past it.
   * Default 10,000.
   *
   * A TTL alone does not bound a cache. Entries only expire when someone reads
   * them, and a workload with high key cardinality (per-tenant keys, per-commit
   * keys, per-filter query keys) mints faster than it re-reads, so the map grows
   * monotonically until the process dies. Eviction is always semantically safe
   * for a cache — a miss is a correct answer — so this is on by default rather
   * than opt-in.
   *
   * Set `0` for the previous unbounded behaviour. Only do that if something else
   * in your process bounds the keyspace.
   */
  maxEntries?: number;
}

/** Minimal in-memory `Map`-backed adapter with per-key TTL, LRU eviction and
 *  prefix invalidation. */
export function createMemoryCacheAdapter(options: MemoryCacheAdapterOptions = {}): CacheAdapter {
  const maxEntries = options.maxEntries ?? 10_000;
  const store = new Map<string, { value: unknown; expiresAt: number }>();
  const now = () => Date.now();

  /** Map iteration order is insertion order, so re-inserting on read makes the
   *  first key the least-recently-used one. */
  function evictIfNeeded(): void {
    if (maxEntries <= 0) return;
    while (store.size > maxEntries) {
      const oldest = store.keys().next().value;
      if (oldest === undefined) return;
      store.delete(oldest);
    }
  }

  function readUnexpired(key: string): { value: unknown; expiresAt: number } | undefined {
    const entry = store.get(key);
    if (!entry) return undefined;
    if (entry.expiresAt !== 0 && entry.expiresAt < now()) {
      store.delete(key);
      return undefined;
    }
    store.delete(key); // promote to most-recently-used
    store.set(key, entry);
    return entry;
  }

  return {
    get(key: string): unknown | undefined {
      const value = readUnexpired(key)?.value;
      // Tag-index storage uses `Set<string>` internally for `O(1)`
      // dedup on append. Expose to consumers as an array — Sets aren't
      // JSON-serializable so callers depending on adapter portability
      // (Redis sees arrays) get a consistent shape.
      if (value instanceof Set) return Array.from(value as Set<unknown>);
      return value;
    },
    set(key: string, value: unknown, ttlSeconds = 60): void {
      const expiresAt = ttlSeconds === 0 ? 0 : now() + ttlSeconds * 1000;
      store.delete(key);
      store.set(key, { value, expiresAt });
      evictIfNeeded();
    },
    delete(key: string): void {
      store.delete(key);
    },
    clear(pattern?: string): void {
      if (pattern === undefined) {
        store.clear();
        return;
      }
      // Simple glob: only `prefix:*` is supported.
      const prefix = pattern.endsWith('*') ? pattern.slice(0, -1) : pattern;
      for (const key of store.keys()) {
        if (key.startsWith(prefix)) store.delete(key);
      }
    },
    /**
     * Atomic add-to-set — `O(M)` per call where M is the number of
     * new members. Stores the value as `Set<string>` internally for
     * `O(1)` membership checks; `get` exposes it back as an array for
     * cross-adapter portability. JS's single-thread guarantee makes
     * the read-mutate-write race-free without locks.
     */
    addToSet(key: string, members: readonly string[], ttlSeconds = 60): number {
      const existing = readUnexpired(key);
      let set: Set<string>;
      if (existing && existing.value instanceof Set) {
        set = existing.value as Set<string>;
      } else {
        set = new Set();
        // If `existing` was a non-Set value (e.g. previously written
        // via `set`), addToSet replaces it with a Set — same semantic
        // as Redis where SADD on a non-set key throws (we accept the
        // overwrite as a more forgiving behavior).
        const expiresAt = existing?.expiresAt ?? (ttlSeconds === 0 ? 0 : now() + ttlSeconds * 1000);
        store.set(key, { value: set, expiresAt });
        evictIfNeeded();
      }
      let added = 0;
      for (const m of members) {
        if (!set.has(m)) {
          set.add(m);
          added++;
        }
      }
      return added;
    },
    /**
     * Atomic increment — JS's single-threaded execution model makes
     * this race-free without locks. Mirrors Redis's `INCRBY key by` +
     * `EXPIRE key ttlSeconds NX`: TTL is applied only on key creation,
     * existing keys keep their original expiry.
     */
    increment(key: string, by = 1, ttlSeconds = 60): number {
      const existing = readUnexpired(key);
      const previousNum =
        existing && typeof existing.value === 'number' && Number.isFinite(existing.value)
          ? existing.value
          : 0;
      const next = previousNum + by;
      // Preserve existing expiresAt on increment (NX semantics); set
      // fresh TTL only when the key was absent.
      const expiresAt = existing
        ? existing.expiresAt
        : ttlSeconds === 0
          ? 0
          : now() + ttlSeconds * 1000;
      store.set(key, { value: next, expiresAt });
      evictIfNeeded();
      return next;
    },
  };
}
