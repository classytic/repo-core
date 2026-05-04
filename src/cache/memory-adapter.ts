/**
 * Reference in-memory adapter implementing `CacheAdapter`.
 *
 * Not for production scale — use Redis / KV / Memcached for real hosts.
 * Ships in repo-core because tests + single-process apps shouldn't each
 * reinvent the TTL + glob-invalidation logic, and the implementation is
 * genuinely driver-free.
 */

import type { CacheAdapter } from './types.js';

/** Minimal in-memory `Map`-backed adapter with per-key TTL + prefix invalidation. */
export function createMemoryCacheAdapter(): CacheAdapter {
  const store = new Map<string, { value: unknown; expiresAt: number }>();
  const now = () => Date.now();

  function readUnexpired(key: string): { value: unknown; expiresAt: number } | undefined {
    const entry = store.get(key);
    if (!entry) return undefined;
    if (entry.expiresAt !== 0 && entry.expiresAt < now()) {
      store.delete(key);
      return undefined;
    }
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
      store.set(key, { value, expiresAt });
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
      return next;
    },
  };
}
