/**
 * `CacheAdapter` contract + `createMemoryCacheAdapter` reference impl.
 *
 * Locks the shape arc + mongokit + sqlitekit all compose against:
 *   - get / set / del — required
 *   - clear(pattern?) — optional glob invalidation
 *   - ttlSeconds — seconds, not ms (matches Redis `SET EX`)
 *   - sync OR async returns both accepted
 */

import { describe, expect, it, vi } from 'vitest';
import { type CacheAdapter, createMemoryCacheAdapter } from '../../../src/cache/index.js';
// `stableStringify` is internal — reach in via deep import for the test.
import { stableStringify } from '../../../src/cache/stable-stringify.js';

describe('createMemoryCacheAdapter', () => {
  it('satisfies the CacheAdapter contract structurally', () => {
    const adapter: CacheAdapter = createMemoryCacheAdapter();
    expect(typeof adapter.get).toBe('function');
    expect(typeof adapter.set).toBe('function');
    expect(typeof adapter.delete).toBe('function');
    expect(typeof adapter.clear).toBe('function');
  });

  it('round-trips values via get/set', () => {
    const adapter = createMemoryCacheAdapter();
    adapter.set('k1', { hello: 'world' });
    expect(adapter.get('k1')).toEqual({ hello: 'world' });
  });

  it('delete removes a single key', () => {
    const adapter = createMemoryCacheAdapter();
    adapter.set('k1', 1);
    adapter.set('k2', 2);
    adapter.delete('k1');
    expect(adapter.get('k1')).toBeUndefined();
    expect(adapter.get('k2')).toBe(2);
  });

  it('clear() with no pattern wipes everything', () => {
    const adapter = createMemoryCacheAdapter();
    adapter.set('a', 1);
    adapter.set('b', 2);
    adapter.clear?.();
    expect(adapter.get('a')).toBeUndefined();
    expect(adapter.get('b')).toBeUndefined();
  });

  it('clear(prefix:*) wipes matching keys only', () => {
    const adapter = createMemoryCacheAdapter();
    adapter.set('users:1', 1);
    adapter.set('users:2', 2);
    adapter.set('products:1', 3);
    adapter.clear?.('users:*');
    expect(adapter.get('users:1')).toBeUndefined();
    expect(adapter.get('users:2')).toBeUndefined();
    expect(adapter.get('products:1')).toBe(3);
  });

  it('ttlSeconds expires values after the configured duration', () => {
    vi.useFakeTimers();
    try {
      const adapter = createMemoryCacheAdapter();
      adapter.set('k1', 'v', 60); // 60s TTL
      expect(adapter.get('k1')).toBe('v');
      vi.advanceTimersByTime(30_000);
      expect(adapter.get('k1')).toBe('v');
      vi.advanceTimersByTime(31_000);
      expect(adapter.get('k1')).toBeUndefined();
    } finally {
      vi.useRealTimers();
    }
  });

  it('ttlSeconds=0 means no expiry', () => {
    vi.useFakeTimers();
    try {
      const adapter = createMemoryCacheAdapter();
      adapter.set('k1', 'v', 0);
      vi.advanceTimersByTime(365 * 24 * 60 * 60 * 1000);
      expect(adapter.get('k1')).toBe('v');
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('stableStringify', () => {
  it('produces identical output for objects with different key orders', () => {
    expect(stableStringify({ a: 1, b: 2 })).toBe(stableStringify({ b: 2, a: 1 }));
  });

  it('preserves array order', () => {
    expect(stableStringify([1, 2, 3])).not.toBe(stableStringify([3, 2, 1]));
  });

  it('handles nested objects deterministically', () => {
    const a = stableStringify({ outer: { b: 2, a: 1 }, list: [1, 2] });
    const b = stableStringify({ list: [1, 2], outer: { a: 1, b: 2 } });
    expect(a).toBe(b);
  });

  it('round-trips primitives via JSON.stringify semantics', () => {
    expect(stableStringify('hello')).toBe('"hello"');
    expect(stableStringify(42)).toBe('42');
    expect(stableStringify(null)).toBe('null');
    expect(stableStringify(true)).toBe('true');
  });
});
