/**
 * Portable cache adapter contract.
 *
 * Kits (mongokit / sqlitekit / pgkit / prismakit) ship their own
 * `cachePlugin` compositions; repo-core only owns the interface they
 * write against. Production hosts provide the concrete adapter —
 * Redis, Cloudflare KV, Memcached, in-memory Map.
 */

/** Abstract cache adapter. Sync or async return types both accepted. */
export interface CacheAdapter {
  get(key: string): Promise<unknown | undefined> | unknown | undefined;
  set(key: string, value: unknown, ttlSeconds?: number): Promise<void> | void;
  del(key: string): Promise<void> | void;
  /**
   * Invalidate every key matching a pattern (glob with trailing `*`).
   * Simpler adapters may no-op and rely on TTL — kits must tolerate that.
   */
  delByPattern?(pattern: string): Promise<void> | void;
}
