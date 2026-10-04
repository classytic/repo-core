/**
 * Invalidation is never undone by timing:
 *   - a memo load already in flight when `invalidate` runs cannot repopulate the memo, and a `get`
 *     after the invalidation never joins that stale load;
 *   - a tag index outlives its NEWEST member, so invalidating the tag still finds it.
 */

import { afterEach, describe, expect, it, vi } from 'vitest';
import { createTtlMemo } from '../../../src/cache/memo.js';
import { createMemoryCacheAdapter } from '../../../src/cache/memory-adapter.js';

afterEach(() => {
  vi.useRealTimers();
});

describe('createTtlMemo — invalidate is fenced against in-flight loads', () => {
  it('a load in flight at invalidate time does not repopulate, and a later get sees the new value', async () => {
    let version = 'v1';
    let release: () => void = () => {};
    const load = vi.fn(async () => {
      const seen = version;
      if (seen === 'v1') await new Promise<void>((r) => (release = r));
      return seen;
    });
    const memo = createTtlMemo(load, { ttlMs: 60_000 });

    const first = memo.get('k'); // starts the v1 load
    await memo.invalidate('k'); // data changed underneath it
    version = 'v2';
    const second = memo.get('k'); // must NOT join the stale load
    release();

    expect(await first).toBe('v1');
    expect(await second).toBe('v2');
    // And the stale load did not overwrite the fresh answer.
    expect(await memo.get('k')).toBe('v2');
    expect(load).toHaveBeenCalledTimes(2);
  });

  it('a full invalidate() fences every key the same way', async () => {
    let version = 'v1';
    let release: () => void = () => {};
    const memo = createTtlMemo(
      async () => {
        const seen = version;
        if (seen === 'v1') await new Promise<void>((r) => (release = r));
        return seen;
      },
      { ttlMs: 60_000 },
    );
    const first = memo.get('k');
    await memo.invalidate();
    version = 'v2';
    release();
    await first;
    expect(await memo.get('k')).toBe('v2');
  });
});

describe('memory adapter — a set outlives its newest member', () => {
  it('addToSet extends the expiry (GT) instead of keeping the creation-time one', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-01-01T00:00:00Z'));
    const adapter = createMemoryCacheAdapter();

    await adapter.addToSet?.('tag:orders', ['entry-a'], 60);
    vi.setSystemTime(new Date('2026-01-01T00:00:50Z'));
    await adapter.addToSet?.('tag:orders', ['entry-b'], 60);
    vi.setSystemTime(new Date('2026-01-01T00:01:10Z')); // past the FIRST member's horizon

    expect(await adapter.get('tag:orders')).toEqual(expect.arrayContaining(['entry-b']));
  });

  it('never shortens: a shorter TTL on a later add keeps the longer horizon', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-01-01T00:00:00Z'));
    const adapter = createMemoryCacheAdapter();
    await adapter.addToSet?.('tag:x', ['a'], 600);
    await adapter.addToSet?.('tag:x', ['b'], 10);
    vi.setSystemTime(new Date('2026-01-01T00:05:00Z'));
    expect(await adapter.get('tag:x')).toEqual(expect.arrayContaining(['a', 'b']));
  });
});
