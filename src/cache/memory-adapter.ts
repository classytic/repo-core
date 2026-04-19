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

  return {
    get(key: string): unknown | undefined {
      const entry = store.get(key);
      if (!entry) return undefined;
      if (entry.expiresAt !== 0 && entry.expiresAt < now()) {
        store.delete(key);
        return undefined;
      }
      return entry.value;
    },
    set(key: string, value: unknown, ttlSeconds = 60): void {
      const expiresAt = ttlSeconds === 0 ? 0 : now() + ttlSeconds * 1000;
      store.set(key, { value, expiresAt });
    },
    del(key: string): void {
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
  };
}
