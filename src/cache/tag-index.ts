/**
 * Tag side-index — non-pattern-dependent tag invalidation.
 *
 * Adapters that don't support `clear(pattern)` (most plain KV stores,
 * Upstash REST, in-memory `Map` adapters) can still implement
 * tag-based group invalidation via this side-index: every `set` adds
 * the entry's key to each tag's index list; `invalidateByTags` reads
 * the index, deletes the listed keys, and clears the index.
 *
 * **TTL hygiene.** The index entry's TTL tracks the longest-lived
 * cached entry under that tag. When the data behind every key under
 * a tag has expired, the index naturally evicts too — preventing
 * unbounded growth on hot tags.
 *
 * **Parallelization.** Both `appendKeyToTags` and `invalidateByTags`
 * fan out adapter operations via `Promise.all` — for Redis-backed
 * adapters this means N tags / M keys complete in 1 RTT (pipelined)
 * instead of N+M sequential RTTs. Single-key paths bypass the
 * scheduling overhead.
 *
 * **Non-transactional.** A crash between writing the entry and
 * appending to the index — or between deleting entries and clearing
 * the index — leaves stale references. Stale references resolve to
 * `undefined` on next read (treated as miss); the TTL is the safety
 * net for orphaned index entries.
 */

import { tagIndexKey } from './keys.js';
import type { CacheAdapter } from './types.js';

/**
 * Append `cacheKey` to each tag's index in parallel. Uses
 * `adapter.addToSet` when available (Redis SADD, in-memory mutation)
 * for `O(M)` appends; falls back to GET+SET-array otherwise.
 *
 * **Performance note.** The benchmark suite measured `O(N²)` overhead
 * on the GET+SET fallback (178× slower than no-tags writes at hot-tag
 * sizes). The fast path eliminates the per-write array copy entirely.
 *
 * The index is set with a TTL matching the entry's own TTL — when the
 * entry naturally expires, its index reference does too, bounding
 * index growth. Dedups same-key writes (SWR refresh re-writes the
 * same key) so the index doesn't grow unboundedly under SWR.
 */
export async function appendKeyToTags(
  adapter: CacheAdapter,
  prefix: string,
  cacheKey: string,
  tags: readonly string[],
  ttlSeconds: number,
): Promise<void> {
  if (tags.length === 0) return;
  // Index TTL tracks the entry's TTL. A 24h cap guards against
  // `staleTime + gcTime` configurations that exceed reasonable
  // retention windows — at that horizon the cache itself becomes a
  // store, and a tag-index outliving it isn't useful.
  const indexTtl = Math.min(Math.max(ttlSeconds, 60), 24 * 60 * 60);

  // Fast path — atomic addToSet on adapters that support it.
  if (adapter.addToSet) {
    const fn = adapter.addToSet.bind(adapter);
    await Promise.all(tags.map((tag) => fn(tagIndexKey(prefix, tag), [cacheKey], indexTtl)));
    return;
  }

  // Fallback — GET + SET array. O(N) per tag in existing index size.
  await Promise.all(
    tags.map(async (tag) => {
      const idxKey = tagIndexKey(prefix, tag);
      const existing = (await adapter.get(idxKey)) as string[] | undefined;
      const current = Array.isArray(existing) ? existing : [];
      if (current.includes(cacheKey)) return;
      const next = [...current, cacheKey];
      await adapter.set(idxKey, next, indexTtl);
    }),
  );
}

/**
 * Read each tag's index in parallel, delete every listed cache entry
 * + each index in parallel, and return the count of distinct cache
 * entries removed.
 *
 * For a Redis-backed adapter pipelining these operations, this is
 * effectively 2 RTTs (read-fan-out + delete-fan-out) regardless of
 * tag/entry count — vs N+M sequential RTTs in the prior impl.
 *
 * Returns `0` when no tags were provided or no entries matched.
 */
export async function invalidateByTags(
  adapter: CacheAdapter,
  prefix: string,
  tags: readonly string[],
): Promise<number> {
  if (tags.length === 0) return 0;

  // Phase 1 — fan-out reads of every tag index in parallel.
  const indexKeys = tags.map((t) => tagIndexKey(prefix, t));
  const indices = await Promise.all(indexKeys.map((k) => adapter.get(k)));

  // Collect distinct cache keys across all indices (dedup so the
  // count reflects entries, not tag×entry pairs).
  const cacheKeys = new Set<string>();
  for (const idx of indices) {
    if (Array.isArray(idx)) {
      for (const k of idx as string[]) cacheKeys.add(k);
    }
  }

  // Phase 2 — fan-out deletes of every cache entry + every tag index
  // in parallel. A pipelined adapter executes this in a single RTT.
  const deletions: Array<Promise<void> | void> = [];
  for (const k of cacheKeys) deletions.push(adapter.delete(k));
  for (const k of indexKeys) deletions.push(adapter.delete(k));
  await Promise.all(deletions);

  return cacheKeys.size;
}
