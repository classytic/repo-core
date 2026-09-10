/**
 * `createTtlMemo` — the ONE way to memoise a keyed async load for a while.
 *
 * Four packages had each hand-rolled `Map<key, { at, value }>` with a TTL, and
 * every one wrote the entry AFTER its await. Under parallel dispatch N callers
 * reach the await together, all miss, and the cache only ever helps the NEXT
 * caller — a 30 s TTL that measured nine reads per event. The assertions here
 * are the ones those maps would fail.
 */
import { describe, expect, it, vi } from 'vitest';
import { createTtlMemo } from '../../../src/cache/memo.js';

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe('createTtlMemo — single flight', () => {
  it('N concurrent calls for one key run the loader ONCE and all get the value', async () => {
    const load = vi.fn(async (key: string) => {
      await sleep(10);
      return `rows-for-${key}`;
    });
    const memo = createTtlMemo(load, { ttlMs: 30_000 });

    const results = await Promise.all(Array.from({ length: 9 }, () => memo.get('org-1')));

    expect(load).toHaveBeenCalledTimes(1);
    expect(new Set(results)).toEqual(new Set(['rows-for-org-1']));
  });

  it('a later call within the TTL is served without loading', async () => {
    const load = vi.fn(async () => 'v');
    const memo = createTtlMemo(load, { ttlMs: 30_000 });
    await memo.get('k');
    await memo.get('k');
    expect(load).toHaveBeenCalledTimes(1);
  });

  it('distinct keys load independently', async () => {
    const load = vi.fn(async (k: string) => k);
    const memo = createTtlMemo(load, { ttlMs: 30_000 });
    await Promise.all([memo.get('a'), memo.get('b')]);
    expect(load).toHaveBeenCalledTimes(2);
  });

  it('a throwing loader fails every waiter and caches NOTHING — the next call retries', async () => {
    let calls = 0;
    const load = vi.fn(async () => {
      calls += 1;
      if (calls === 1) throw new Error('db down');
      return 'ok';
    });
    const memo = createTtlMemo(load, { ttlMs: 30_000 });

    const first = Promise.allSettled([memo.get('k'), memo.get('k')]);
    const settled = await first;
    expect(settled.every((s) => s.status === 'rejected')).toBe(true);
    expect(load).toHaveBeenCalledTimes(1);

    await expect(memo.get('k')).resolves.toBe('ok');
  });
});

describe('createTtlMemo — expiry and invalidation', () => {
  it('reloads once the TTL has elapsed', async () => {
    const load = vi.fn(async () => 'v');
    const memo = createTtlMemo(load, { ttlMs: 20 });
    await memo.get('k');
    await sleep(35);
    await memo.get('k');
    expect(load).toHaveBeenCalledTimes(2);
  });

  it('invalidate(key) drops one key; invalidate() drops all', async () => {
    const load = vi.fn(async (k: string) => k);
    const memo = createTtlMemo(load, { ttlMs: 30_000 });
    await memo.get('a');
    await memo.get('b');
    await memo.invalidate('a');
    await memo.get('a');
    await memo.get('b');
    expect(load).toHaveBeenCalledTimes(3);
    await memo.invalidate();
    await memo.get('b');
    expect(load).toHaveBeenCalledTimes(4);
  });

  it('ttlMs: 0 disables memoisation entirely — every call loads', async () => {
    const load = vi.fn(async () => 'v');
    const memo = createTtlMemo(load, { ttlMs: 0 });
    await memo.get('k');
    await memo.get('k');
    expect(load).toHaveBeenCalledTimes(2);
  });

  it('memoises a null result — "no row" is an answer, not a miss', async () => {
    const load = vi.fn(async () => null);
    const memo = createTtlMemo(load, { ttlMs: 30_000 });
    expect(await memo.get('k')).toBeNull();
    expect(await memo.get('k')).toBeNull();
    expect(load).toHaveBeenCalledTimes(1);
  });
});

describe('createTtlMemo — composite keys', () => {
  it('keyOf lets a caller fold a revision into the key so a bump is a miss', async () => {
    const load = vi.fn(async (k: { org: string | null; rev: number }) => `${k.org}@${k.rev}`);
    const memo = createTtlMemo(load, {
      ttlMs: 30_000,
      keyOf: (k) => `${k.org ?? '__company__'}:${k.rev}`,
    });
    await memo.get({ org: null, rev: 1 });
    await memo.get({ org: null, rev: 1 });
    await memo.get({ org: null, rev: 2 });
    expect(load).toHaveBeenCalledTimes(2);
  });

  it('REFUSES an object key without keyOf — identity-keyed caching never hits and looks like a bug', () => {
    const memo = createTtlMemo(async (k: { id: string }) => k.id, { ttlMs: 30_000 });
    expect(() => memo.get({ id: 'x' })).toThrow(/keyOf/);
  });
});
