/**
 * `CacheEngine` — TTL + SWR + tag-invalidation behavior on top of any
 * `CacheAdapter`. Tests the state machine the kits + arc compose against.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { CacheEngine } from '../../../src/cache/engine.js';
import { createMemoryCacheAdapter } from '../../../src/cache/memory-adapter.js';
import { resolveCacheOptions } from '../../../src/cache/options.js';

function resolved(o: Record<string, unknown> = {}) {
  return resolveCacheOptions(o, undefined, undefined);
}

describe('CacheEngine — read state machine', () => {
  beforeEach(() => {
    vi.useFakeTimers({ now: new Date('2026-01-01T00:00:00Z') });
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('returns "miss" when the key was never set', async () => {
    const engine = new CacheEngine(createMemoryCacheAdapter());
    const result = await engine.get('k', resolved({ enabled: true }));
    expect(result.status).toBe('miss');
    expect(result.data).toBeUndefined();
  });

  it('returns "fresh" inside the staleTime window', async () => {
    const engine = new CacheEngine(createMemoryCacheAdapter());
    await engine.set('k', { v: 1 }, resolved({ staleTime: 30, gcTime: 60 }));
    vi.advanceTimersByTime(10_000); // 10s in
    const result = await engine.get('k', resolved({ staleTime: 30, gcTime: 60 }));
    expect(result.status).toBe('fresh');
    expect(result.data).toEqual({ v: 1 });
    expect(result.age).toBe(10);
  });

  it('returns "stale" past staleTime when swr=true', async () => {
    const engine = new CacheEngine(createMemoryCacheAdapter());
    await engine.set('k', { v: 1 }, resolved({ staleTime: 30, gcTime: 60, swr: true }));
    vi.advanceTimersByTime(45_000); // 45s in (past staleTime, within gc)
    const result = await engine.get('k', resolved({ staleTime: 30, gcTime: 60, swr: true }));
    expect(result.status).toBe('stale');
    expect(result.data).toEqual({ v: 1 });
  });

  it('returns "miss" past staleTime when swr=false (forced refetch)', async () => {
    const engine = new CacheEngine(createMemoryCacheAdapter());
    await engine.set('k', { v: 1 }, resolved({ staleTime: 30, gcTime: 60, swr: false }));
    vi.advanceTimersByTime(45_000);
    const result = await engine.get('k', resolved({ staleTime: 30, gcTime: 60, swr: false }));
    expect(result.status).toBe('miss');
  });

  it('returns "miss" past staleTime + gcTime (expired) even with swr=true', async () => {
    const engine = new CacheEngine(createMemoryCacheAdapter());
    await engine.set('k', { v: 1 }, resolved({ staleTime: 30, gcTime: 60, swr: true }));
    vi.advanceTimersByTime(95_000); // 95s in (past staleTime + gcTime)
    const result = await engine.get('k', resolved({ staleTime: 30, gcTime: 60, swr: true }));
    expect(result.status).toBe('miss');
  });

  it('returns "disabled" when enabled=false', async () => {
    const engine = new CacheEngine(createMemoryCacheAdapter());
    await engine.set('k', { v: 1 }, resolved({ staleTime: 60 }));
    const result = await engine.get('k', resolved({ enabled: false }));
    expect(result.status).toBe('disabled');
  });

  it('returns "bypass" when bypass=true (regardless of cached value)', async () => {
    const engine = new CacheEngine(createMemoryCacheAdapter());
    await engine.set('k', { v: 1 }, resolved({ staleTime: 60 }));
    const result = await engine.get('k', resolved({ bypass: true }));
    expect(result.status).toBe('bypass');
    expect(result.data).toBeUndefined();
  });

  it('skips writes when enabled=false (no cache pollution from disabled calls)', async () => {
    const engine = new CacheEngine(createMemoryCacheAdapter());
    await engine.set('k', { v: 1 }, resolved({ enabled: false }));
    const result = await engine.get('k', resolved({ enabled: true }));
    expect(result.status).toBe('miss');
  });
});

describe('CacheEngine — tag-based invalidation', () => {
  it('invalidates entries by tag', async () => {
    const engine = new CacheEngine(createMemoryCacheAdapter());
    await engine.set('k1', { v: 1 }, resolved({ staleTime: 60, tags: ['orders'] }));
    await engine.set('k2', { v: 2 }, resolved({ staleTime: 60, tags: ['orders'] }));
    await engine.set('k3', { v: 3 }, resolved({ staleTime: 60, tags: ['users'] }));

    const count = await engine.invalidateByTags(['orders']);
    expect(count).toBe(2);

    expect((await engine.get('k1', resolved({ staleTime: 60 }))).status).toBe('miss');
    expect((await engine.get('k2', resolved({ staleTime: 60 }))).status).toBe('miss');
    expect((await engine.get('k3', resolved({ staleTime: 60 }))).status).toBe('fresh');
  });

  it('returns 0 when no tags supplied (no-op)', async () => {
    const engine = new CacheEngine(createMemoryCacheAdapter());
    const count = await engine.invalidateByTags([]);
    expect(count).toBe(0);
  });

  it('multi-tag invalidation deduplicates the affected entries', async () => {
    const engine = new CacheEngine(createMemoryCacheAdapter());
    // One entry under both 'orders' AND 'urgent' — counted once.
    await engine.set('k1', { v: 1 }, resolved({ staleTime: 60, tags: ['orders', 'urgent'] }));
    await engine.set('k2', { v: 2 }, resolved({ staleTime: 60, tags: ['orders'] }));

    const count = await engine.invalidateByTags(['orders', 'urgent']);
    expect(count).toBe(2);
  });
});

describe('CacheEngine — version-based invalidation', () => {
  it('initial version is 0', async () => {
    const engine = new CacheEngine(createMemoryCacheAdapter());
    expect(await engine.getVersion('orders')).toBe(0);
  });

  it('bumpVersion advances and returns the new value', async () => {
    const engine = new CacheEngine(createMemoryCacheAdapter());
    const v1 = await engine.bumpVersion('orders');
    expect(v1).toBeGreaterThan(0);
    const before = await engine.getVersion('orders');
    expect(before).toBe(v1);
  });

  it('versions are isolated per model', async () => {
    const engine = new CacheEngine(createMemoryCacheAdapter());
    await engine.bumpVersion('orders');
    expect(await engine.getVersion('users')).toBe(0);
  });
});

describe('CacheEngine — TTL jitter', () => {
  it('identity by default (no jitter)', async () => {
    const adapter = createMemoryCacheAdapter();
    const setSpy = vi.spyOn(adapter, 'set');
    const engine = new CacheEngine(adapter);
    await engine.set('k', 'v', resolved({ staleTime: 30, gcTime: 60 }));
    expect(setSpy).toHaveBeenCalledWith('k', expect.anything(), 90);
  });

  it('symmetric fractional jitter clamps within ±fraction', async () => {
    const adapter = createMemoryCacheAdapter();
    const setSpy = vi.spyOn(adapter, 'set');
    const engine = new CacheEngine(adapter, { jitter: 0.1 });
    await engine.set('k', 'v', resolved({ staleTime: 100, gcTime: 0 }));
    const ttlArg = setSpy.mock.calls[0]?.[2] as number;
    expect(ttlArg).toBeGreaterThanOrEqual(90);
    expect(ttlArg).toBeLessThanOrEqual(110);
  });

  it('custom jitter function is used as-is (clamped to ≥1s)', async () => {
    const adapter = createMemoryCacheAdapter();
    const setSpy = vi.spyOn(adapter, 'set');
    const engine = new CacheEngine(adapter, { jitter: () => 0 });
    await engine.set('k', 'v', resolved({ staleTime: 30 }));
    const ttlArg = setSpy.mock.calls[0]?.[2] as number;
    expect(ttlArg).toBeGreaterThanOrEqual(1);
  });
});
