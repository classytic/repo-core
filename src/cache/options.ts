/**
 * Canonical per-call cache options. TanStack Query-shaped — the same
 * `staleTime` / `gcTime` mental model browser developers already know,
 * lifted to server-side multi-tenant safe.
 *
 * **Scope discipline.** This is the ONE shape used across every read
 * method on every kit (`getById`, `getAll`, `aggregate`, `count`, ...).
 * Replaces mongokit's `AggCacheOptions`, sqlitekit's per-op overrides,
 * and arc's `QueryCacheConfig`. One mental model, one wire shape.
 *
 * **Freshness semantics:**
 *   - `0 ≤ age < staleTime`            → fresh; serve cache, no refresh
 *   - `staleTime ≤ age < staleTime + gcTime`
 *       - `swr: true`  → serve cache, kick off background refresh
 *       - `swr: false` → treat as miss, fetch fresh inline
 *   - `age ≥ staleTime + gcTime`       → expired; entry evicted
 *
 * Defaults match TanStack v5 / Next.js App Router idioms — short
 * `staleTime` (data is stale immediately, refetch on next request),
 * generous `gcTime` (keep entries around so the next request can serve
 * stale-while-revalidate).
 */
export interface CacheOptions {
  /**
   * Seconds the entry is considered fresh. `0` (default) means "always
   * stale" — the entry serves via SWR if `swr: true`, otherwise every
   * call re-fetches.
   */
  staleTime?: number;
  /**
   * Seconds the entry stays in cache after it goes stale. Past this
   * point the entry is evicted entirely. Default: `60`.
   */
  gcTime?: number;
  /**
   * Group invalidation tags. Pass to `repo.invalidateCache(tags)` to
   * wipe every entry tagged with any of the matching tags. Convention:
   * namespace by domain — `'orders'`, `'org:abc123'`, `'user:42'`.
   *
   * The plugin auto-injects scope tags (`org:<id>` / `user:<id>`) when
   * `autoTagsFromScope: true` (default), so hosts only declare
   * domain-level tags.
   */
  tags?: readonly string[];
  /**
   * Force a fresh fetch + cache write. Use for "Refresh" buttons or
   * explicit revalidation flows where the user expects up-to-the-second
   * data. Bypasses both the read AND any in-flight SWR refresh — the
   * cached entry is overwritten with the fresh result.
   */
  bypass?: boolean;
  /**
   * Stale-while-revalidate. When `true`, stale entries serve
   * immediately and a background refresh updates the cache for the
   * next request. When `false` (default), stale entries trigger an
   * inline refetch — caller waits for fresh data.
   *
   * **Recommended `true`** for high-traffic dashboards where
   * cache-edge latency matters more than strict freshness.
   */
  swr?: boolean;
  /**
   * Skip cache entirely for this call. Equivalent to TanStack Query's
   * `enabled: false`. Default: `true` (cache active).
   *
   * Distinguished from `bypass`: `enabled: false` skips both read AND
   * write, so a fresh fetch doesn't pollute the cache. `bypass: true`
   * skips read but DOES write the fresh result.
   */
  enabled?: boolean;
  /**
   * Override the auto-derived cache key. The default key includes
   * model, op, version, params hash, and scope tags — sufficient for
   * 99% of cases. Override only when you want explicit control
   * (cross-call sharing, debugging).
   *
   * **Caller owns uniqueness.** Two calls passing the same `key` for
   * different request shapes get the first writer's result.
   */
  key?: string;
}

/** Per-call result envelope returned by `CacheEngine.get()`. */
export interface CacheReadResult<TData = unknown> {
  /**
   * - `'fresh'`    — within `staleTime`; cache is authoritative
   * - `'stale'`    — past `staleTime`, within gc window; serve + revalidate
   * - `'miss'`     — no entry, expired entry, or cache disabled
   * - `'disabled'` — `enabled: false` for this call
   * - `'bypass'`   — `bypass: true` for this call
   */
  readonly status: 'fresh' | 'stale' | 'miss' | 'disabled' | 'bypass';
  /** Cached data when `status` is `'fresh'` or `'stale'`; otherwise `undefined`. */
  readonly data: TData | undefined;
  /** Age of the cached entry in seconds (only when status is fresh/stale). */
  readonly age?: number;
}

/**
 * Resolved cache options after merging plugin defaults + per-op
 * defaults + per-call overrides. All fields populated; never undefined.
 */
export interface ResolvedCacheOptions {
  staleTime: number;
  gcTime: number;
  tags: readonly string[];
  bypass: boolean;
  swr: boolean;
  enabled: boolean;
  key?: string;
}

/**
 * Merge precedence (highest wins): per-call > per-op-default > plugin-default > built-in.
 *
 * Built-in defaults: `staleTime=0`, `gcTime=60`, `swr=false`,
 * `enabled=true`, `bypass=false`, `tags=[]`.
 */
export function resolveCacheOptions(
  callOpts: CacheOptions | undefined,
  perOpDefaults: Partial<CacheOptions> | undefined,
  pluginDefaults: Partial<CacheOptions> | undefined,
): ResolvedCacheOptions {
  const merged: CacheOptions = {
    ...pluginDefaults,
    ...perOpDefaults,
    ...callOpts,
  };
  return {
    staleTime: Math.max(0, merged.staleTime ?? 0),
    gcTime: Math.max(0, merged.gcTime ?? 60),
    tags: merged.tags ?? [],
    bypass: merged.bypass ?? false,
    swr: merged.swr ?? false,
    enabled: merged.enabled ?? true,
    ...(merged.key !== undefined ? { key: merged.key } : {}),
  };
}
