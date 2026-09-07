/**
 * The batch loader's contract. Each test is one way a loop-per-item rewrite
 * silently produces wrong data rather than a slow one.
 */
import { describe, expect, it, vi } from 'vitest';
import { createBatchLoader } from '../../../src/loader/batch-loader.js';

/** A batch fn that honours the positional contract, and counts its calls. */
function idLoader(store: Record<string, string> = { a: 'A', b: 'B', c: 'C' }) {
  const calls: string[][] = [];
  const batch = vi.fn(async (keys: readonly string[]) => {
    calls.push([...keys]);
    return keys.map((k) => store[k]);
  });
  return { batch, calls };
}

describe('createBatchLoader', () => {
  it('coalesces keys issued in one tick into ONE call', async () => {
    const { batch, calls } = idLoader();
    const loader = createBatchLoader({ batch });

    const out = await Promise.all([loader.load('a'), loader.load('b'), loader.load('c')]);

    expect(out).toEqual(['A', 'B', 'C']);
    expect(batch).toHaveBeenCalledOnce();
    expect(calls[0]).toEqual(['a', 'b', 'c']);
  });

  it('the same key twice in one tick is ONE fetch with two waiters', async () => {
    const { batch, calls } = idLoader();
    const loader = createBatchLoader({ batch });

    const out = await Promise.all([loader.load('a'), loader.load('a')]);

    expect(out).toEqual(['A', 'A']);
    expect(calls[0]).toEqual(['a']);
  });

  it('a repeated key in a LATER tick is served from cache, not re-fetched', async () => {
    const { batch } = idLoader();
    const loader = createBatchLoader({ batch });

    await loader.load('a');
    await loader.load('a');

    expect(batch).toHaveBeenCalledOnce();
    expect(loader.stats.cacheHits).toBe(1);
  });

  it('loadMany issues one call for the whole list', async () => {
    const { batch, calls } = idLoader();
    const loader = createBatchLoader({ batch });

    expect(await loader.loadMany(['a', 'b'])).toEqual(['A', 'B']);
    expect(calls).toEqual([['a', 'b']]);
  });

  it('a missing key resolves undefined — absence is not an error', async () => {
    const { batch } = idLoader();
    const loader = createBatchLoader({ batch });

    expect(await loader.load('zzz')).toBeUndefined();
  });

  /**
   * The defect this primitive exists to make impossible: a short result array
   * shifts every later value onto the wrong key, and each value is
   * individually well-formed, so nothing downstream can notice.
   */
  it('REFUSES a batch whose result length does not match the keys', async () => {
    const loader = createBatchLoader<string, string>({
      batch: async (keys) => keys.slice(1).map((k) => k.toUpperCase()),
    });

    await expect(Promise.all([loader.load('a'), loader.load('b')])).rejects.toThrow(
      /returned 1 results for 2 keys/,
    );
  });

  it('rejects EVERY waiter when the batch throws', async () => {
    const loader = createBatchLoader<string, string>({
      batch: async () => {
        throw new Error('db down');
      },
    });

    const a = loader.load('a');
    const b = loader.load('b');

    await expect(a).rejects.toThrow('db down');
    await expect(b).rejects.toThrow('db down');
  });

  it('a FAILED key is not cached — the next call retries it', async () => {
    let n = 0;
    const loader = createBatchLoader<string, string>({
      batch: async (keys) => {
        n += 1;
        if (n === 1) throw new Error('transient');
        return keys.map((k) => k.toUpperCase());
      },
    });

    await expect(loader.load('a')).rejects.toThrow('transient');
    expect(await loader.load('a')).toBe('A');
    expect(n).toBe(2);
  });

  it('splits at maxBatchSize instead of building one unbounded query', async () => {
    const { batch, calls } = idLoader({});
    const loader = createBatchLoader({ batch, maxBatchSize: 2 });

    await loader.loadMany(['a', 'b', 'c', 'd', 'e']);

    expect(calls.map((c) => c.length)).toEqual([2, 2, 1]);
  });

  it('prime seeds a value so it is never fetched', async () => {
    const { batch } = idLoader();
    const loader = createBatchLoader({ batch });

    loader.prime('a', 'PRIMED');

    expect(await loader.load('a')).toBe('PRIMED');
    expect(batch).not.toHaveBeenCalled();
  });

  it('clear(key) drops one entry; clear() drops all', async () => {
    const { batch } = idLoader();
    const loader = createBatchLoader({ batch });

    await loader.load('a');
    loader.clear('a');
    await loader.load('a');
    expect(batch).toHaveBeenCalledTimes(2);

    loader.clear();
    await loader.load('a');
    expect(batch).toHaveBeenCalledTimes(3);
  });

  /**
   * `String({})` is `[object Object]` for EVERY object, so without `keyOf` an
   * object-keyed loader silently merges unrelated keys into one entry and hands
   * the first one's value to all of them.
   */
  it('keyOf distinguishes object keys that String() would merge', async () => {
    const seen: unknown[][] = [];
    const loader = createBatchLoader<{ sku: string }, string>({
      keyOf: (k) => k.sku,
      batch: async (keys) => {
        seen.push([...keys]);
        return keys.map((k) => k.sku.toUpperCase());
      },
    });

    const out = await Promise.all([loader.load({ sku: 'a' }), loader.load({ sku: 'b' })]);

    expect(out).toEqual(['A', 'B']);
    expect(seen[0]).toHaveLength(2);
  });

  it('two loaders do not share a cache — scope is per operation', async () => {
    const { batch } = idLoader();

    await createBatchLoader({ batch }).load('a');
    await createBatchLoader({ batch }).load('a');

    expect(batch).toHaveBeenCalledTimes(2);
  });

  it('batches across independent async callers in the same tick', async () => {
    const { batch, calls } = idLoader();
    const loader = createBatchLoader({ batch });

    // Two unrelated code paths, neither aware of the other.
    const one = (async () => loader.load('a'))();
    const two = (async () => loader.load('b'))();
    await Promise.all([one, two]);

    expect(calls).toEqual([['a', 'b']]);
  });

  it('reports batches and keys so a caller can assert the round-trip count', async () => {
    const { batch } = idLoader();
    const loader = createBatchLoader({ batch });

    await loader.loadMany(['a', 'b', 'c']);

    expect(loader.stats).toMatchObject({ batches: 1, keys: 3 });
  });
});

/**
 * The guards a review found missing. Each of these previously produced a
 * plausible wrong answer or an unresolved promise, with nothing reported.
 */
describe('createBatchLoader — refusals', () => {
  it('REFUSES an object key with no keyOf instead of collapsing them to [object Object]', async () => {
    const loader = createBatchLoader<{ sku: string }, string>({
      batch: async (k) => k.map(() => 'X'),
    });

    expect(() => loader.load({ sku: 'a' })).toThrow(/needs an explicit `keyOf`/);
  });

  it.each([
    Number.NaN,
    0,
    -1,
    2.5,
    Number.POSITIVE_INFINITY,
  ])('REFUSES maxBatchSize %p at construction rather than hanging every waiter', (bad) => {
    expect(() =>
      createBatchLoader<string, string>({ batch: async (k) => [...k], maxBatchSize: bad }),
    ).toThrow(/positive integer/);
  });

  it('clear(key) does not abandon the caller already waiting on an in-flight fetch', async () => {
    let n = 0;
    const loader = createBatchLoader<string, string>({
      batch: async (keys) => {
        n += 1;
        return keys.map(() => `v${n}`);
      },
    });

    const first = loader.load('a');
    loader.clear('a');

    // The original waiter still settles — dropping its queue entry would hang it.
    await expect(first).resolves.toBe('v1');
    // And a LATER load re-fetches rather than reading the invalidated value.
    await expect(loader.load('a')).resolves.toBe('v2');
  });
});

/**
 * The failure the LENGTH check cannot see: right length, every value
 * `undefined`, because the lookup was keyed on a different type. Silent, and
 * indistinguishable from "these rows do not exist".
 */
describe('createBatchLoader — requireAllResolved', () => {
  it('REFUSES a batch that resolved nothing when every key was expected to hit', async () => {
    const loader = createBatchLoader<string, string>({
      requireAllResolved: true,
      // Correct length, wrong key identity — the classic ObjectId/string slip.
      batch: async (keys) => keys.map(() => undefined),
    });

    await expect(loader.loadMany(['a', 'b'])).rejects.toThrow(/resolved NOTHING/);
  });

  it('allows a PARTIAL miss — that is a real absence, not a key mismatch', async () => {
    const loader = createBatchLoader<string, string>({
      requireAllResolved: true,
      batch: async (keys) => keys.map((k) => (k === 'a' ? 'A' : undefined)),
    });

    expect(await loader.loadMany(['a', 'b'])).toEqual(['A', undefined]);
  });

  it('is OFF by default — a genuine existence check still returns undefined', async () => {
    const loader = createBatchLoader<string, string>({
      batch: async (keys) => keys.map(() => undefined),
    });

    expect(await loader.load('nope')).toBeUndefined();
  });
});

/** The trap is real; `stats.batches` is the only thing that shows it. */
describe('createBatchLoader — the awaited-loop trap', () => {
  it('a sequential await loop batches NOTHING, and stats say so', async () => {
    const seen: number[] = [];
    const loader = createBatchLoader<string, string>({
      batch: async (keys) => {
        seen.push(keys.length);
        return keys.map((k) => k.toUpperCase());
      },
    });

    for (const k of ['a', 'b', 'c']) await loader.load(k);

    expect(seen).toEqual([1, 1, 1]);
    expect(loader.stats.batches).toBe(3);
  });

  it('loadMany over the same keys is ONE batch', async () => {
    const seen: number[] = [];
    const loader = createBatchLoader<string, string>({
      batch: async (keys) => {
        seen.push(keys.length);
        return keys.map((k) => k.toUpperCase());
      },
    });

    await loader.loadMany(['a', 'b', 'c']);

    expect(seen).toEqual([3]);
    expect(loader.stats.batches).toBe(1);
  });
});
