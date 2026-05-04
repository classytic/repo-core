/**
 * `CacheEngine.prefetch(key, opts, fetcher)` — cache warming with
 * single-flight semantics. TanStack Query equivalent:
 * `queryClient.prefetchQuery({ queryKey, queryFn })`.
 */

import { describe, expect, it, vi } from 'vitest';
import { CacheEngine } from '../../../src/cache/engine.js';
import { createMemoryCacheAdapter } from '../../../src/cache/memory-adapter.js';
import { resolveCacheOptions } from '../../../src/cache/options.js';

const fresh = () => resolveCacheOptions({ staleTime: 60 }, undefined, undefined);

describe('CacheEngine.prefetch', () => {
  it('miss path: runs fetcher, stores result, returns value', async () => {
    const engine = new CacheEngine(createMemoryCacheAdapter());
    const fetcher = vi.fn().mockResolvedValue({ id: 1, name: 'x' });
    const v = await engine.prefetch('k', fresh(), fetcher);
    expect(v).toEqual({ id: 1, name: 'x' });
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it('hit path: returns cached value WITHOUT running fetcher', async () => {
    const engine = new CacheEngine(createMemoryCacheAdapter());
    await engine.set('k', { v: 1 }, fresh());

    const fetcher = vi.fn().mockResolvedValue({ v: 999 });
    const v = await engine.prefetch('k', fresh(), fetcher);
    expect(v).toEqual({ v: 1 });
    expect(fetcher).not.toHaveBeenCalled();
  });

  it('single-flight: 100 concurrent prefetches run fetcher exactly once', async () => {
    const engine = new CacheEngine(createMemoryCacheAdapter());
    let runs = 0;
    const fetcher = async () => {
      runs++;
      await new Promise((r) => setTimeout(r, 10));
      return { v: 42 };
    };

    const results = await Promise.all(
      Array.from({ length: 100 }, () => engine.prefetch('k', fresh(), fetcher)),
    );

    expect(runs).toBe(1);
    expect(results).toHaveLength(100);
    expect(results.every((r) => (r as { v: number }).v === 42)).toBe(true);
  });

  it('bypass: forces fresh fetch + writes (skips single-flight)', async () => {
    const engine = new CacheEngine(createMemoryCacheAdapter());
    await engine.set('k', { v: 1 }, fresh());

    const opts = resolveCacheOptions({ staleTime: 60, bypass: true }, undefined, undefined);
    const fetcher = vi.fn().mockResolvedValue({ v: 2 });
    const v = await engine.prefetch('k', opts, fetcher);
    expect(v).toEqual({ v: 2 });
    expect(fetcher).toHaveBeenCalledTimes(1);

    // Bypass wrote — next non-bypass prefetch sees v: 2
    const next = await engine.prefetch('k', fresh(), vi.fn().mockResolvedValue({ v: 999 }));
    expect(next).toEqual({ v: 2 });
  });

  it('disabled: runs fetcher but does NOT write to cache', async () => {
    const engine = new CacheEngine(createMemoryCacheAdapter());
    const opts = resolveCacheOptions({ enabled: false }, undefined, undefined);
    const fetcher = vi.fn().mockResolvedValue({ v: 1 });
    const v = await engine.prefetch('k', opts, fetcher);
    expect(v).toEqual({ v: 1 });
    expect(fetcher).toHaveBeenCalledTimes(1);

    // Cache wasn't populated — next call still misses.
    const second = await engine.prefetch('k', fresh(), vi.fn().mockResolvedValue({ v: 2 }));
    expect(second).toEqual({ v: 2 });
  });

  it('fetcher error rejects pending — concurrent waiters see the same error', async () => {
    const engine = new CacheEngine(createMemoryCacheAdapter());
    const fetcher = vi.fn().mockRejectedValue(new Error('upstream'));

    const r1 = engine.prefetch('k', fresh(), fetcher);
    const r2 = engine.prefetch('k', fresh(), fetcher);

    await expect(r1).rejects.toThrow('upstream');
    await expect(r2).rejects.toThrow('upstream');
    expect(fetcher).toHaveBeenCalledTimes(1); // single-flight still dedupes
  });

  it('stale + swr=true: returns stale cached value (no fetcher run)', async () => {
    vi.useFakeTimers({ now: new Date('2026-01-01T00:00:00Z') });
    try {
      const engine = new CacheEngine(createMemoryCacheAdapter());
      const opts = resolveCacheOptions(
        { staleTime: 1, gcTime: 60, swr: true },
        undefined,
        undefined,
      );
      await engine.set('k', { v: 1 }, opts);
      vi.advanceTimersByTime(2000); // past staleTime, within gcTime

      const fetcher = vi.fn().mockResolvedValue({ v: 999 });
      const v = await engine.prefetch('k', opts, fetcher);
      expect(v).toEqual({ v: 1 });
      // SWR: serves stale immediately; fetcher NOT called by prefetch
      // (prefetch is the warming surface, not a triggers-refresh flow).
      expect(fetcher).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });
});
