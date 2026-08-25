/**
 * `CacheAdapterSource` — a cache whose STORE is resolved per call, so its
 * lifetime can be narrower than the process (a request, a job run, a unit of
 * work) without repo-core knowing what any of those are.
 *
 * ## The property that makes this safe
 *
 * The resolver returning `undefined` means INERT — no read, no write, no
 * version row. It must never fall back to a shared store, because that
 * fallback IS the cross-scope leak the scoping exists to prevent, and it
 * would be completely invisible: every call would still return a plausible
 * value, just occasionally someone else's.
 *
 * That is why the "no store" case reuses the EXISTING `disabled` status
 * rather than introducing a new one — every caller already handles `disabled`
 * by fetching fresh, so an out-of-scope call is correct by construction
 * instead of by each caller remembering a new case.
 */

import { describe, expect, it } from 'vitest';
import { CacheEngine } from '../../../src/cache/engine.js';
import { createMemoryCacheAdapter } from '../../../src/cache/memory-adapter.js';
import { resolveCacheOptions } from '../../../src/cache/options.js';

function resolved(o: Record<string, unknown> = {}) {
  return resolveCacheOptions(o, undefined, undefined);
}

describe('CacheAdapterSource — a plain adapter still behaves exactly as before', () => {
  /**
   * The backwards-compatibility gate. Every existing consumer passes a bare
   * adapter; if normalising it to a resolver changed anything, it would
   * change it for all of them at once.
   */
  it('stores and serves through a directly-passed adapter', async () => {
    const engine = new CacheEngine(createMemoryCacheAdapter());
    await engine.set('k', { v: 1 }, resolved({ staleTime: 30 }));
    const hit = await engine.get('k', resolved({ staleTime: 30 }));
    expect(hit.status).toBe('fresh');
    expect(hit.data).toEqual({ v: 1 });
  });
});

describe('CacheAdapterSource — resolver form', () => {
  it('resolves the store on EVERY call, never memoising the first answer', async () => {
    // THE test for this feature. Memoising would serve scope A's entry to
    // scope B — the exact defect the indirection exists to prevent, and the
    // one a naive implementation introduces while every other test passes.
    let current = createMemoryCacheAdapter();
    const engine = new CacheEngine(() => current);

    await engine.set('k', { scope: 'A' }, resolved({ staleTime: 30 }));
    expect((await engine.get('k', resolved({ staleTime: 30 }))).data).toEqual({ scope: 'A' });

    // A new scope begins — a fresh store, as a per-request adapter would be.
    current = createMemoryCacheAdapter();
    const inNewScope = await engine.get('k', resolved({ staleTime: 30 }));
    expect(inNewScope.status).toBe('miss');
    expect(inNewScope.data).toBeUndefined();
  });

  it('reads report "disabled" when there is no store for the current scope', async () => {
    const engine = new CacheEngine(() => undefined);
    const result = await engine.get('k', resolved({ staleTime: 30 }));
    expect(result.status).toBe('disabled');
    expect(result.data).toBeUndefined();
  });

  it('writes are a silent no-op with no store — and do not throw', async () => {
    const engine = new CacheEngine(() => undefined);
    await expect(engine.set('k', { v: 1 }, resolved({ staleTime: 30 }))).resolves.toBeUndefined();
  });

  it('does not WRITE into a store that appears later', async () => {
    // A write attempted out of scope must not be buffered and flushed into
    // whatever store shows up next: that would attribute one scope's data to
    // another, which is the leak wearing a different hat.
    let store: ReturnType<typeof createMemoryCacheAdapter> | undefined;
    const engine = new CacheEngine(() => store);

    await engine.set('k', { v: 'written-out-of-scope' }, resolved({ staleTime: 30 }));
    store = createMemoryCacheAdapter();
    expect((await engine.get('k', resolved({ staleTime: 30 }))).status).toBe('miss');
  });

  it('invalidation and versioning are inert rather than throwing', async () => {
    // Correct, not merely defensive: a scoped store is created empty per
    // scope, so a write happening outside one cannot have a stale entry to
    // orphan. Throwing here would make ordinary cron/script writes fail.
    const engine = new CacheEngine(() => undefined);
    await expect(engine.invalidateByTags(['t'])).resolves.toBe(0);
    await expect(engine.getVersion('Order')).resolves.toBe(0);
    await expect(engine.bumpVersion('Order')).resolves.toBe(0);
    await expect(engine.clear()).resolves.toBeUndefined();
  });

  it('an unavailable scope does not poison the next available one', async () => {
    // The realistic sequence: a cron job (no scope) runs between two requests.
    // Neither request may be affected by it.
    let store: ReturnType<typeof createMemoryCacheAdapter> | undefined = createMemoryCacheAdapter();
    const engine = new CacheEngine(() => store);

    await engine.set('k', { v: 1 }, resolved({ staleTime: 30 }));
    store = undefined;
    expect((await engine.get('k', resolved({ staleTime: 30 }))).status).toBe('disabled');

    store = createMemoryCacheAdapter();
    await engine.set('k', { v: 2 }, resolved({ staleTime: 30 }));
    expect((await engine.get('k', resolved({ staleTime: 30 }))).data).toEqual({ v: 2 });
  });
});
