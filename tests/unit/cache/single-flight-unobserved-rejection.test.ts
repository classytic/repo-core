/**
 * A rejected claim with NO waiter must not become an unhandled rejection.
 *
 * `claimPending` creates a deferred for waiters that may never arrive. With a
 * single caller nothing awaits it, so rejecting it on fetch failure raised an
 * `unhandledRejection` — separate from, and in addition to, the error the caller
 * had correctly caught. Under `--unhandled-rejections=strict` that is a process
 * crash from a try/catch that worked.
 *
 * The sibling test in `prefetch.test.ts` never saw it: with two callers the
 * deferred IS awaited. Single caller is the common case.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { CacheEngine } from '../../../src/cache/engine.js';
import { createMemoryCacheAdapter } from '../../../src/cache/memory-adapter.js';
import { resolveCacheOptions } from '../../../src/cache/options.js';

const fresh = () => resolveCacheOptions({ staleTime: 60 }, undefined, undefined);

const unhandled: unknown[] = [];
const capture = (reason: unknown) => {
  unhandled.push(reason);
};

/** Let the microtask queue drain and Node run its unhandled-rejection sweep. */
const settle = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

beforeEach(() => {
  unhandled.length = 0;
  process.on('unhandledRejection', capture);
});
afterEach(() => {
  process.off('unhandledRejection', capture);
});

describe('single-flight: a rejected claim nobody awaited', () => {
  it('prefetch with ONE caller: the caller gets the error and nothing else is raised', async () => {
    const engine = new CacheEngine(createMemoryCacheAdapter());
    await expect(
      engine.prefetch('k', fresh(), async () => {
        throw new Error('upstream');
      }),
    ).rejects.toThrow('upstream');
    await settle();
    expect(unhandled, 'the deferred created for absent waiters leaked its rejection').toEqual([]);
  });

  it('claim + reject with no waiter, directly — the plugin read path', async () => {
    const engine = new CacheEngine(createMemoryCacheAdapter());
    expect(engine.claimPending('k')).toEqual({ status: 'claimed' });
    engine.rejectPending('k', new Error('upstream'));
    await settle();
    expect(unhandled).toEqual([]);
  });

  it('a waiter that DOES exist still receives the rejection', async () => {
    const engine = new CacheEngine(createMemoryCacheAdapter());
    expect(engine.claimPending('k')).toEqual({ status: 'claimed' });
    const waiter = engine.claimPending('k');
    expect(waiter.status).toBe('wait');
    engine.rejectPending('k', new Error('upstream'));
    if (waiter.status !== 'wait') throw new Error('unreachable');
    await expect(waiter.promise).rejects.toThrow('upstream');
    await settle();
    expect(unhandled).toEqual([]);
  });
});
