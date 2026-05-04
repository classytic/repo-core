/**
 * Collection-version store — O(1) bulk invalidation by bumping a
 * counter that's embedded in every cache key.
 *
 * **Per-scope sharding** (TanStack-style targeted invalidation).
 * Without scope, a write to the model bumps ONE counter and orphans
 * every cached read for that model — including OTHER tenants' caches.
 * With a `scopeKey` (e.g. `'org:abc'`), the version key becomes
 * `<prefix>:ver:<model>:<scopeKey>` so the write only invalidates the
 * writing tenant's cache.
 *
 * **Atomic-when-supported.** The adapter MAY ship `increment(key, by,
 * ttl)` for atomic counter bumps. When present, concurrent writes
 * from multiple pods produce strictly-monotonic versions (no lost
 * bumps). When absent, falls back to `get → max → set` — correct in
 * single-pod, racy in multi-pod (rare bump-loss; mitigated by the
 * `Date.now()` floor below).
 *
 * **Strict monotonicity** — fallback path uses
 * `max(Date.now(), previous + 1)` so same-millisecond writes still
 * advance the counter (atomic path is naturally monotonic via
 * adapter.increment).
 */

import { versionKey } from './keys.js';
import type { CacheAdapter } from './types.js';

const VERSION_TTL_SECONDS = 24 * 60 * 60;

/**
 * Read the current version for a `model` (optionally per-scope). Returns
 * `0` when no version has been set yet — the initial value before any
 * writes have hit.
 */
export async function getModelVersion(
  adapter: CacheAdapter,
  prefix: string,
  model: string,
  scopeKey?: string,
): Promise<number> {
  const value = await adapter.get(versionKey(prefix, model, scopeKey));
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  return 0;
}

/**
 * Bump the model's version (per-scope when `scopeKey` is supplied) to
 * a strictly-monotonic value. Returns the new value.
 *
 * Atomic when the adapter supports `increment` — concurrent multi-pod
 * writes produce distinct versions. Falls back to `get → max → set`
 * otherwise; under concurrent multi-pod load, two writes may collide
 * on the same `previous` and one bump is lost — accepted trade-off
 * for adapters without atomic counters (Cloudflare KV, etc.).
 */
export async function bumpModelVersion(
  adapter: CacheAdapter,
  prefix: string,
  model: string,
  scopeKey?: string,
): Promise<number> {
  const key = versionKey(prefix, model, scopeKey);

  // Atomic path — preferred when the adapter ships it. Versions are
  // monotonically increasing integers (1, 2, 3, ...) which is fine
  // for cache-key derivation; no need to encode wall-clock time.
  if (adapter.increment) {
    return await adapter.increment(key, 1, VERSION_TTL_SECONDS);
  }

  // Fallback — racy under multi-pod concurrent writes but correct in
  // single-pod / single-isolate contexts. The `Date.now()` floor keeps
  // versions advancing across same-millisecond bumps.
  const previous = await adapter.get(key);
  const previousNum = typeof previous === 'number' && Number.isFinite(previous) ? previous : 0;
  const next = Math.max(Date.now(), previousNum + 1);
  await adapter.set(key, next, VERSION_TTL_SECONDS);
  return next;
}
