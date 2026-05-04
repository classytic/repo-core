/**
 * Cache entry envelope. Mirrors TanStack Query's freshness model:
 * `staleAfter` separates fresh from stale; `expiresAt` marks eviction.
 *
 * `tags` ride on the envelope (not on the adapter contract) so tag
 * invalidation works against any `CacheAdapter` — even those without
 * `clear(pattern)`. The plugin maintains a side-index mapping
 * `tag → keys` to invalidate without scanning the cache space.
 */
export interface CacheEnvelope<TData = unknown> {
  readonly version: 1;
  readonly data: TData;
  /** Wall-clock ms when the entry was written. */
  readonly createdAt: number;
  /** Wall-clock ms when the entry transitions from fresh to stale. */
  readonly staleAfter: number;
  /** Wall-clock ms when the adapter should evict the entry. */
  readonly expiresAt: number;
  readonly tags: readonly string[];
}

/** Build an envelope from raw data + freshness windows (seconds). */
export function buildEnvelope<TData>(
  data: TData,
  staleTimeSeconds: number,
  gcTimeSeconds: number,
  tags: readonly string[],
  now: number = Date.now(),
): CacheEnvelope<TData> {
  const staleAfter = now + Math.max(0, staleTimeSeconds) * 1000;
  const expiresAt = staleAfter + Math.max(0, gcTimeSeconds) * 1000;
  return { version: 1, data, createdAt: now, staleAfter, expiresAt, tags };
}

/**
 * Inspect an envelope against the current wall-clock time. Returns
 * structured freshness state — caller chooses how to act on `'stale'`
 * (serve + revalidate vs treat as miss) based on its SWR config.
 */
export function inspectEnvelope<TData>(
  envelope: CacheEnvelope<TData> | undefined,
  now: number = Date.now(),
): { state: 'fresh' | 'stale' | 'expired' | 'missing'; envelope?: CacheEnvelope<TData> } {
  if (!envelope || envelope.version !== 1) return { state: 'missing' };
  if (now >= envelope.expiresAt) return { state: 'expired' };
  if (now < envelope.staleAfter) return { state: 'fresh', envelope };
  return { state: 'stale', envelope };
}

/** Type guard — distinguishes a stored envelope from raw cached values. */
export function isCacheEnvelope(value: unknown): value is CacheEnvelope {
  if (!value || typeof value !== 'object') return false;
  const v = value as Record<string, unknown>;
  return (
    v['version'] === 1 &&
    typeof v['createdAt'] === 'number' &&
    typeof v['staleAfter'] === 'number' &&
    typeof v['expiresAt'] === 'number' &&
    Array.isArray(v['tags'])
  );
}
