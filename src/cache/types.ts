/**
 * Portable cache adapter contract.
 *
 * Kits (mongokit / sqlitekit / pgkit / prismakit) ship their own
 * `cachePlugin` compositions; arc's `cache/QueryCache` composes on top of
 * the same interface. One concrete Redis / KV / Memcached / in-memory
 * implementation plugs into every consumer — no 95%-identical duplicates.
 *
 * ## What this contract covers
 *
 * Just the key-value transport layer — `get` / `set` / `del` / optional
 * `clear`. Higher-level semantics (tag-based invalidation, SWR,
 * stale-while-revalidate, hit-rate metrics, serialization) belong in the
 * *consumer*, not the adapter. That keeps one adapter implementation
 * re-usable across consumers with different cache strategies.
 *
 * ## TTL unit
 *
 * `ttlSeconds` — seconds, not milliseconds. Matches Redis (`SET key value
 * EX seconds`), which is the dominant backend. `0` or `undefined` means no
 * expiry; adapters are free to apply a default.
 *
 * ## Sync-or-async return types
 *
 * Both accepted. An in-memory `Map` adapter returns values synchronously; a
 * Redis adapter returns Promises. Consumers `await` either way — awaiting
 * a non-Promise value is a no-op at runtime.
 */
export interface CacheAdapter {
  /** Get a value by key. Returns `undefined` when not found or expired. */
  get(key: string): Promise<unknown | undefined> | unknown | undefined;

  /** Store a value with optional TTL (seconds). */
  set(key: string, value: unknown, ttlSeconds?: number): Promise<void> | void;

  /** Delete a single key. No-op when the key doesn't exist. */
  del(key: string): Promise<void> | void;

  /**
   * Invalidate keys matching a glob pattern (typically `prefix:*`), or
   * every key when `pattern` is omitted.
   *
   * Optional — simpler adapters that can't enumerate keys (some KV stores)
   * may omit this and rely on TTL for eventual consistency. Consumers that
   * need strict invalidation must check for its presence: `adapter.clear?.(pattern)`.
   *
   * Named `clear` (matching mongokit + arc) rather than `delByPattern` so
   * one interface flows across every layer.
   */
  clear?(pattern?: string): Promise<void> | void;
}
