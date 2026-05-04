/**
 * `CacheEngine` — the SWR + TTL + tag-invalidation behavior on top of
 * a `CacheAdapter`. ONE implementation of the cache-flow primitives,
 * shared across every kit + arc + Express/Nest hosts.
 *
 * Replaces three independent implementations:
 *   - mongokit's `withAggCache` (TTL/SWR/tag flow for aggregate)
 *   - mongokit's CRUD `cachePlugin` (TTL + version-bump for getById/getAll)
 *   - arc's `QueryCache` (TTL + SWR + version-bump + tag-version)
 *
 * **Production hardening (TanStack-inspired):**
 *   - **Single-flight on miss** — concurrent misses for the same key
 *     wait on the first fetch's promise (no cache stampede).
 *   - **Per-scope version-bump** — writes only invalidate the writing
 *     scope's cache, not other tenants' (targeted invalidation).
 *   - **Strictly-monotonic version** — same-millisecond writes never
 *     collide.
 *
 * Hosts compose this via `cachePlugin` (declarative, hook-driven) or
 * call it directly when they need fine-grained control.
 */

import { buildEnvelope, type CacheEnvelope, inspectEnvelope } from './envelope.js';
import type { CacheReadResult, ResolvedCacheOptions } from './options.js';
import { appendKeyToTags, invalidateByTags as invalidateByTagsImpl } from './tag-index.js';
import type { CacheAdapter } from './types.js';
import { bumpModelVersion, getModelVersion } from './version-store.js';

export interface CacheEngineOptions {
  /** Cache key namespace prefix. Default: `'rc'`. */
  prefix?: string;
  /**
   * TTL jitter — randomizes the actual stored TTL so cache stampedes
   * don't synchronize across many entries written together. Pass a
   * number in `(0, 1]` for symmetric fractional jitter (`0.1` =
   * uniform ±10%) or a function for custom logic. Default: `0` (off).
   */
  jitter?: number | ((ttl: number) => number);
}

/**
 * In-flight claim outcome. `'claimed'` → caller owns the fetch;
 * `'wait'` → caller awaits an already-in-flight fetch.
 */
export type SingleFlightClaim<T = unknown> =
  | { readonly status: 'claimed' }
  | { readonly status: 'wait'; readonly promise: Promise<T> };

export class CacheEngine {
  private readonly adapter: CacheAdapter;
  private readonly prefix: string;
  private readonly jitter: (ttl: number) => number;
  /**
   * In-flight fetches keyed by cache-key. Process-local (lives in this
   * engine instance) — server restart clears it; cross-pod fanout is
   * fine because each pod runs its own single-flight, and downstream
   * load is bounded to N-pods worst case (a huge improvement over
   * unbounded burst).
   */
  private readonly pending = new Map<string, PromiseWithResolvers<unknown>>();

  constructor(adapter: CacheAdapter, options: CacheEngineOptions = {}) {
    this.adapter = adapter;
    this.prefix = options.prefix ?? 'rc';
    this.jitter = resolveJitter(options.jitter);
  }

  /**
   * Read a cache entry under SWR + TTL semantics. Returns a
   * structured `CacheReadResult` describing freshness state — the
   * caller decides whether to serve, revalidate, or fetch fresh.
   *
   * **State table:**
   *   - `enabled: false`  → `{ status: 'disabled' }` — caller fetches
   *   - `bypass: true`    → `{ status: 'bypass' }`   — caller fetches
   *   - missing / expired → `{ status: 'miss' }`     — caller fetches
   *   - fresh             → `{ status: 'fresh', data }`
   *   - stale + swr=true  → `{ status: 'stale', data }` — caller serves + bg-refreshes
   *   - stale + swr=false → `{ status: 'miss' }`        — caller fetches
   */
  async get<TData>(key: string, opts: ResolvedCacheOptions): Promise<CacheReadResult<TData>> {
    if (!opts.enabled) return { status: 'disabled', data: undefined };
    if (opts.bypass) return { status: 'bypass', data: undefined };
    const raw = (await this.adapter.get(key)) as CacheEnvelope<TData> | undefined;
    const inspection = inspectEnvelope<TData>(raw);
    if (inspection.state === 'missing' || inspection.state === 'expired') {
      return { status: 'miss', data: undefined };
    }
    const env = inspection.envelope;
    if (!env) return { status: 'miss', data: undefined };
    const ageSeconds = Math.floor((Date.now() - env.createdAt) / 1000);
    if (inspection.state === 'fresh') {
      return { status: 'fresh', data: env.data, age: ageSeconds };
    }
    // stale
    if (opts.swr) return { status: 'stale', data: env.data, age: ageSeconds };
    return { status: 'miss', data: undefined };
  }

  /**
   * Write `value` under `key` with the resolved options. Skips silently
   * when `enabled: false` (no cache pollution from disabled calls).
   *
   * Side effect: appends `key` to the tag side-index for every tag in
   * `opts.tags` so future `invalidateByTags` calls find it.
   */
  async set<TData>(key: string, value: TData, opts: ResolvedCacheOptions): Promise<void> {
    if (!opts.enabled) return;
    const tags = opts.tags;
    const envelope = buildEnvelope(value, opts.staleTime, opts.gcTime, tags);
    const totalSeconds = opts.staleTime + opts.gcTime;
    const ttl = this.jitter(totalSeconds);
    await this.adapter.set(key, envelope, ttl);
    if (tags.length > 0) {
      await appendKeyToTags(this.adapter, this.prefix, key, tags, ttl);
    }
  }

  // ── Single-flight (cache-stampede dedup) ─────────────────────────

  /**
   * Look up an in-flight fetch for `key`. Returns the promise the
   * first miss-claimer registered, or `undefined` when no fetch is
   * pending.
   */
  getPending<T = unknown>(key: string): Promise<T> | undefined {
    return this.pending.get(key)?.promise as Promise<T> | undefined;
  }

  /**
   * Atomically claim `key` for a fetch. Returns `'claimed'` when this
   * caller owns the fetch (it must call `resolvePending` or
   * `rejectPending` when done) or `{ status: 'wait', promise }` when
   * another caller already claimed — the returned promise resolves
   * with the first claimer's result.
   */
  claimPending<T = unknown>(key: string): SingleFlightClaim<T> {
    const existing = this.pending.get(key);
    if (existing) {
      return { status: 'wait', promise: existing.promise as Promise<T> };
    }
    // Node 22+ ships `Promise.withResolvers()` natively — zero
    // indirection on the single-flight hot path.
    this.pending.set(key, Promise.withResolvers<unknown>());
    return { status: 'claimed' };
  }

  /** Resolve an in-flight claim with the fresh result + clear it. */
  resolvePending<T>(key: string, value: T): void {
    const deferred = this.pending.get(key);
    if (!deferred) return;
    this.pending.delete(key);
    (deferred as PromiseWithResolvers<T>).resolve(value);
  }

  /**
   * Reject an in-flight claim — waiters fail-fast (they DON'T retry
   * inline; they get the same error as the claimer). Caller's choice
   * whether to retry on a higher level.
   */
  rejectPending(key: string, error: unknown): void {
    const deferred = this.pending.get(key);
    if (!deferred) return;
    this.pending.delete(key);
    deferred.reject(error);
  }

  /** Internal — number of in-flight fetches; observability hook. */
  get pendingCount(): number {
    return this.pending.size;
  }

  // ── Invalidation ─────────────────────────────────────────────────

  /**
   * Invalidate every entry tagged with ANY of the provided tags. Reads
   * each tag's index, deletes the listed cache entries, and clears
   * the index. Returns the count of entries removed.
   */
  async invalidateByTags(tags: readonly string[]): Promise<number> {
    return invalidateByTagsImpl(this.adapter, this.prefix, tags);
  }

  /**
   * Read a model's current version (optionally per-scope). Used by
   * the plugin to embed `v<version>` into every cache key so a single
   * version bump orphans the model's cache space.
   */
  async getVersion(model: string, scopeKey?: string): Promise<number> {
    return getModelVersion(this.adapter, this.prefix, model, scopeKey);
  }

  /**
   * Bump the model's version (per-scope when `scopeKey` is supplied)
   * to invalidate every cached read for it. Per-scope bumps don't
   * affect other tenants' caches — TanStack-style targeted
   * invalidation.
   */
  async bumpVersion(model: string, scopeKey?: string): Promise<number> {
    return bumpModelVersion(this.adapter, this.prefix, model, scopeKey);
  }

  /** Wipe the entire cache namespace (when the adapter supports `clear`). */
  async clear(): Promise<void> {
    if (this.adapter.clear) await this.adapter.clear(`${this.prefix}:*`);
  }

  /** Expose the prefix so plugins building keys downstream stay aligned. */
  get keyPrefix(): string {
    return this.prefix;
  }

  // ── Prefetch (cache warming) ──────────────────────────────────────

  /**
   * Warm the cache for `key` if it's not already populated. On hit
   * (fresh OR stale) returns the cached value; on miss runs `fetcher`,
   * stores the result, and returns it. Single-flight guarantees apply
   * — concurrent `prefetch` calls for the same key share one fetcher
   * invocation.
   *
   * **Use case:** preload dashboards before the user request lands
   * (route-level `prefetch` after auth, scheduled-job warmup, server-
   * push hints from a CDN edge).
   *
   * **Difference from `engine.get` + manual write:** this one method
   * handles the miss-fetch-store sequence atomically, with single-
   * flight dedup. Mirrors TanStack Query's
   * `queryClient.prefetchQuery({ queryKey, queryFn })`.
   */
  async prefetch<TData>(
    key: string,
    opts: ResolvedCacheOptions,
    fetcher: () => Promise<TData>,
  ): Promise<TData> {
    // Fast path — fresh or stale-with-swr serves immediately.
    const result = await this.get<TData>(key, opts);
    if (result.status === 'fresh' || result.status === 'stale') {
      return result.data as TData;
    }

    // Miss / disabled / bypass — single-flight on misses; bypass and
    // disabled run the fetcher every time (no claim).
    if (result.status === 'miss') {
      const claim = this.claimPending<TData>(key);
      if (claim.status === 'wait') {
        return await claim.promise;
      }
      try {
        const value = await fetcher();
        await this.set(key, value, opts);
        this.resolvePending(key, value);
        return value;
      } catch (err) {
        this.rejectPending(key, err);
        throw err;
      }
    }

    // bypass / disabled — fetch, store (if enabled), don't single-flight.
    const value = await fetcher();
    if (opts.enabled) await this.set(key, value, opts);
    return value;
  }
}

function resolveJitter(
  jitter: number | ((ttl: number) => number) | undefined,
): (ttl: number) => number {
  if (!jitter) return (ttl) => ttl;
  if (typeof jitter === 'function') return (ttl) => Math.max(1, Math.round(jitter(ttl)));
  const fraction = Math.min(1, Math.max(0, jitter));
  if (fraction === 0) return (ttl) => ttl;
  return (ttl) => {
    const delta = ttl * fraction;
    const jittered = ttl - delta + Math.random() * 2 * delta;
    return Math.max(1, Math.round(jittered));
  };
}
