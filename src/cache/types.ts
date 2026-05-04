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

  /**
   * Delete a single key. No-op when the key doesn't exist.
   *
   * Named `delete` (not `del`) to match the rest of the ecosystem:
   * `MinimalRepo.delete(id)` in this same package, JavaScript's native
   * `Map.delete` / `Set.delete`, arc's `RepositoryLike.delete`, and every
   * higher-level cache library (Keyv, etc.). Redis clients keep their
   * own `.del()` method — adapter implementations translate.
   */
  delete(key: string): Promise<void> | void;

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

  /**
   * Atomic add-to-set — append `members` to the set at `key`,
   * creating it when absent. Existing members are no-ops (idempotent).
   * Returns the count of newly-added members.
   *
   * **Why optional.** The cache engine's tag side-index uses this
   * for `O(M)` appends instead of the GET+SET-array fallback (which
   * is `O(N²)` per write — read the whole list, copy, append, write
   * back). At scale (hot tags with thousands of entries) the
   * difference is the 178× slowdown the in-memory benchmark surfaced.
   *
   * **Implementation guidance:**
   *   - Redis: `SADD key m1 m2 ...` + `EXPIRE key ttlSeconds NX`
   *   - Memory: in-place push on the underlying array (no copy)
   *   - DynamoDB: `UpdateItem` with `ADD` action on a String Set
   *   - Cloudflare KV / pure GET-SET stores: omit; engine falls back.
   *
   * `ttlSeconds` is applied only when the key is created — existing
   * sets keep their original expiry (Redis NX semantics).
   */
  addToSet?(key: string, members: readonly string[], ttlSeconds?: number): Promise<number> | number;

  /**
   * Atomic increment — adds `by` (default 1) to the integer at `key`,
   * creating the key with value `by` when absent. Returns the NEW
   * value. `ttlSeconds` is applied only when the key is created (most
   * implementations match Redis SETEX-on-INCR semantics).
   *
   * **Why optional.** Pure KV stores without atomic counters
   * (Cloudflare Workers KV, file-backed stores) can't implement this
   * without external coordination. The cache engine falls back to a
   * `get → max → set` pattern when `increment` is absent, accepting
   * the (rare, multi-pod) race condition where two simultaneous bumps
   * collide and only one increment records.
   *
   * **Implementation guidance:**
   *   - Redis: `INCRBY key by` + `EXPIRE key ttlSeconds NX`
   *     (NX so existing TTLs aren't reset on every increment)
   *   - Memory: synchronous via JS single-thread guarantee
   *   - DynamoDB / Mongo `$inc`: native atomic update
   *
   * Used by the cache engine's per-scope `bumpModelVersion` to ensure
   * concurrent writes to the same model never lose bumps — every
   * write is reflected in the next read's cache key.
   */
  increment?(key: string, by?: number, ttlSeconds?: number): Promise<number> | number;
}
