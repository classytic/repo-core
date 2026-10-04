/**
 * Single-flight never crosses a cache scope: two scoped stores reading the same key concurrently
 * each run their OWN loader and see their own result, and a call with no store in scope never
 * joins another scope's fetch. Within one scope, dedup is unchanged.
 */

import { AsyncLocalStorage } from 'node:async_hooks';
import { describe, expect, it } from 'vitest';
import { CacheEngine } from '../../../src/cache/engine.js';
import { createMemoryCacheAdapter } from '../../../src/cache/memory-adapter.js';
import { resolveCacheOptions } from '../../../src/cache/options.js';
import type { CacheAdapter } from '../../../src/cache/types.js';

const fresh = () => resolveCacheOptions({ staleTime: 60 }, undefined, undefined);
const scope = new AsyncLocalStorage<CacheAdapter | undefined>();
const inScope = <T>(adapter: CacheAdapter | undefined, fn: () => Promise<T>) =>
  scope.run(adapter, fn);
const slow = (value: string, runs: string[]) => async () => {
  runs.push(value);
  await new Promise((r) => setTimeout(r, 15));
  return value;
};

describe('single-flight is partitioned by scope', () => {
  it('two scopes, one key, concurrently: each scope gets its own result', async () => {
    const engine = new CacheEngine(() => scope.getStore());
    const runs: string[] = [];
    const [a, b] = await Promise.all([
      inScope(createMemoryCacheAdapter(), () =>
        engine.prefetch('order:42', fresh(), slow('scope-A', runs)),
      ),
      inScope(createMemoryCacheAdapter(), () =>
        engine.prefetch('order:42', fresh(), slow('scope-B', runs)),
      ),
    ]);
    expect([a, b]).toEqual(['scope-A', 'scope-B']);
    expect(runs.sort()).toEqual(['scope-A', 'scope-B']);
  });

  it('within ONE scope, concurrent reads still coalesce to one load', async () => {
    const engine = new CacheEngine(() => scope.getStore());
    const runs: string[] = [];
    const store = createMemoryCacheAdapter();
    const results = await inScope(store, () =>
      Promise.all([0, 1, 2].map(() => engine.prefetch('order:42', fresh(), slow('once', runs)))),
    );
    expect(results).toEqual(['once', 'once', 'once']);
    expect(runs).toEqual(['once']);
  });

  it('a call with no store in scope fetches alone — it never joins a scoped fetch', async () => {
    const engine = new CacheEngine(() => scope.getStore());
    const runs: string[] = [];
    const [scoped, unscoped] = await Promise.all([
      inScope(createMemoryCacheAdapter(), () =>
        engine.prefetch('order:42', fresh(), slow('scoped', runs)),
      ),
      inScope(undefined, () => engine.prefetch('order:42', fresh(), slow('cron', runs))),
    ]);
    expect([scoped, unscoped]).toEqual(['scoped', 'cron']);
    expect(engine.pendingCount).toBe(0);
  });
});
