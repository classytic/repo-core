/**
 * `withTimeout(adapter)` — fail-fast wrapper for slow cache backends.
 *
 * Verifies the two `onTimeout` strategies (`'miss'` default, `'throw'`)
 * + that fast operations pass through unchanged + that the adapter
 * contract is preserved (clear / increment optional methods bridged).
 */

import { describe, expect, it, vi } from 'vitest';
import { createMemoryCacheAdapter } from '../../../src/cache/memory-adapter.js';
import { CacheTimeoutError, withTimeout } from '../../../src/cache/timeout-adapter.js';
import type { CacheAdapter } from '../../../src/cache/types.js';

/** Build an adapter where every async op blocks for `delayMs` before completing. */
function slowAdapter(delayMs: number): CacheAdapter {
  const wait = () => new Promise<void>((r) => setTimeout(r, delayMs));
  return {
    async get() {
      await wait();
      return 'value';
    },
    async set() {
      await wait();
    },
    async delete() {
      await wait();
    },
    async clear() {
      await wait();
    },
    async increment() {
      await wait();
      return 42;
    },
  };
}

describe('withTimeout — fast ops pass through', () => {
  it('sync ops pass through unchanged (no timeout overhead)', async () => {
    // Memory adapter is sync — wrapper's withDeadline returns the
    // value directly without scheduling a timer.
    const wrapped = withTimeout(createMemoryCacheAdapter(), { ms: 100 });
    wrapped.set('k', 'v');
    expect(wrapped.get('k')).toBe('v');
  });

  it('fast async ops complete normally', async () => {
    const adapter: CacheAdapter = {
      get: async () => 'fast',
      set: async () => {},
      delete: async () => {},
    };
    const wrapped = withTimeout(adapter, { ms: 250 });
    expect(await wrapped.get('k')).toBe('fast');
  });
});

describe("withTimeout — onTimeout: 'miss' (default)", () => {
  it('get returns undefined on timeout (treated as cache miss)', async () => {
    const wrapped = withTimeout(slowAdapter(100), { ms: 20 });
    expect(await wrapped.get('k')).toBeUndefined();
  });

  it('set silently swallows timeout', async () => {
    const wrapped = withTimeout(slowAdapter(100), { ms: 20 });
    await expect(wrapped.set('k', 'v')).resolves.toBeUndefined();
  });

  it('delete silently swallows timeout', async () => {
    const wrapped = withTimeout(slowAdapter(100), { ms: 20 });
    await expect(wrapped.delete('k')).resolves.toBeUndefined();
  });

  it('increment falls back to 0 on timeout', async () => {
    const wrapped = withTimeout(slowAdapter(100), { ms: 20 });
    expect(await wrapped.increment?.('c')).toBe(0);
  });
});

describe("withTimeout — onTimeout: 'throw'", () => {
  it('get throws CacheTimeoutError', async () => {
    const wrapped = withTimeout(slowAdapter(100), { ms: 20, onTimeout: 'throw' });
    await expect(wrapped.get('k')).rejects.toBeInstanceOf(CacheTimeoutError);
  });

  it('error carries op name + key + ms', async () => {
    const wrapped = withTimeout(slowAdapter(100), { ms: 20, onTimeout: 'throw' });
    try {
      await wrapped.get('my-key');
      throw new Error('expected throw');
    } catch (err) {
      expect(err).toBeInstanceOf(CacheTimeoutError);
      const e = err as CacheTimeoutError;
      expect(e.op).toBe('get');
      expect(e.key).toBe('my-key');
      expect(e.ms).toBe(20);
    }
  });

  it('every op throws (set / delete / clear / increment)', async () => {
    const wrapped = withTimeout(slowAdapter(100), { ms: 10, onTimeout: 'throw' });
    await expect(wrapped.set('k', 'v')).rejects.toBeInstanceOf(CacheTimeoutError);
    await expect(wrapped.delete('k')).rejects.toBeInstanceOf(CacheTimeoutError);
    await expect(wrapped.clear?.()).rejects.toBeInstanceOf(CacheTimeoutError);
    await expect(wrapped.increment?.('c')).rejects.toBeInstanceOf(CacheTimeoutError);
  });
});

describe('withTimeout — onSlow callback', () => {
  it('fires on timeout with op name + ms + key', async () => {
    const onSlow = vi.fn();
    const wrapped = withTimeout(slowAdapter(50), { ms: 10, onSlow });
    await wrapped.get('my-key');
    expect(onSlow).toHaveBeenCalledWith('get', 10, 'my-key');
  });

  it('does NOT fire on fast ops', async () => {
    const onSlow = vi.fn();
    const wrapped = withTimeout(createMemoryCacheAdapter(), { ms: 100, onSlow });
    wrapped.set('k', 'v');
    wrapped.get('k');
    expect(onSlow).not.toHaveBeenCalled();
  });
});

describe('withTimeout — adapter contract preservation', () => {
  it('omits optional methods when source adapter omits them', () => {
    const minimalAdapter: CacheAdapter = {
      get: async () => undefined,
      set: async () => {},
      delete: async () => {},
    };
    const wrapped = withTimeout(minimalAdapter);
    expect(wrapped.clear).toBeUndefined();
    expect(wrapped.increment).toBeUndefined();
  });

  it('bridges optional methods when source adapter has them', () => {
    const wrapped = withTimeout(createMemoryCacheAdapter());
    expect(typeof wrapped.clear).toBe('function');
    expect(typeof wrapped.increment).toBe('function');
  });
});
