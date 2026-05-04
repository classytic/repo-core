/**
 * Single-flight dedup — TanStack-style cache-stampede prevention.
 *
 * When N concurrent requests miss the same cache key, only ONE
 * runs the executor; the rest await the first claimer's promise.
 * Production-critical for high-traffic uncached entries (cold-start,
 * post-deploy, cache-bust burst).
 */

import { describe, expect, it } from 'vitest';
import { CacheEngine } from '../../../src/cache/engine.js';
import { createMemoryCacheAdapter } from '../../../src/cache/memory-adapter.js';

describe('CacheEngine — single-flight (claimPending / getPending / resolvePending)', () => {
  it('first claim succeeds, returns "claimed"', () => {
    const engine = new CacheEngine(createMemoryCacheAdapter());
    const claim = engine.claimPending('key-1');
    expect(claim.status).toBe('claimed');
  });

  it('concurrent claim returns "wait" with the in-flight promise', () => {
    const engine = new CacheEngine(createMemoryCacheAdapter());
    engine.claimPending<string>('key-1');
    const second = engine.claimPending<string>('key-1');
    expect(second.status).toBe('wait');
    if (second.status === 'wait') {
      expect(second.promise).toBeInstanceOf(Promise);
    }
  });

  it('resolvePending releases all waiters with the value', async () => {
    const engine = new CacheEngine(createMemoryCacheAdapter());
    engine.claimPending<string>('key-1');
    const w1 = engine.claimPending<string>('key-1');
    const w2 = engine.claimPending<string>('key-1');
    if (w1.status !== 'wait' || w2.status !== 'wait') throw new Error('expected wait');

    engine.resolvePending('key-1', 'fresh-value');

    expect(await w1.promise).toBe('fresh-value');
    expect(await w2.promise).toBe('fresh-value');
  });

  it('rejectPending fails all waiters fast (no inline retry)', async () => {
    const engine = new CacheEngine(createMemoryCacheAdapter());
    engine.claimPending<string>('key-1');
    const w1 = engine.claimPending<string>('key-1');
    if (w1.status !== 'wait') throw new Error('expected wait');

    engine.rejectPending('key-1', new Error('upstream down'));

    await expect(w1.promise).rejects.toThrow('upstream down');
  });

  it('after resolve, subsequent claim is a fresh "claimed" (not "wait")', () => {
    const engine = new CacheEngine(createMemoryCacheAdapter());
    engine.claimPending<string>('key-1');
    engine.resolvePending('key-1', 'value');
    const next = engine.claimPending('key-1');
    expect(next.status).toBe('claimed');
  });

  it('different keys claim independently — no cross-contamination', () => {
    const engine = new CacheEngine(createMemoryCacheAdapter());
    expect(engine.claimPending('key-A').status).toBe('claimed');
    expect(engine.claimPending('key-B').status).toBe('claimed');
    expect(engine.claimPending('key-A').status).toBe('wait');
    expect(engine.claimPending('key-B').status).toBe('wait');
  });

  it('pendingCount reflects in-flight claims', () => {
    const engine = new CacheEngine(createMemoryCacheAdapter());
    expect(engine.pendingCount).toBe(0);
    engine.claimPending('a');
    engine.claimPending('b');
    expect(engine.pendingCount).toBe(2);
    engine.resolvePending('a', 1);
    expect(engine.pendingCount).toBe(1);
  });

  it('getPending returns undefined when no claim exists', () => {
    const engine = new CacheEngine(createMemoryCacheAdapter());
    expect(engine.getPending('nonexistent')).toBeUndefined();
  });

  it('resolve / reject on unknown key is a silent no-op (idempotent)', () => {
    const engine = new CacheEngine(createMemoryCacheAdapter());
    expect(() => engine.resolvePending('nonexistent', 'x')).not.toThrow();
    expect(() => engine.rejectPending('nonexistent', new Error('x'))).not.toThrow();
  });

  it('integration scenario — 100 concurrent waiters get the same value', async () => {
    const engine = new CacheEngine(createMemoryCacheAdapter());
    engine.claimPending<number>('key-1');

    const waiters = Array.from({ length: 100 }, () => {
      const claim = engine.claimPending<number>('key-1');
      if (claim.status !== 'wait') throw new Error('expected wait');
      return claim.promise;
    });

    setTimeout(() => engine.resolvePending('key-1', 42), 5);
    const results = await Promise.all(waiters);
    expect(results).toHaveLength(100);
    expect(results.every((r) => r === 42)).toBe(true);
  });
});
