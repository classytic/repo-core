/**
 * `cachePlugin` — hook integration over `RepositoryBase`.
 *
 * Drives the plugin against a minimal mock repo (just enough to
 * register hooks + emit them) so we can assert the full lifecycle:
 * before-hook checks cache, after-hook writes, mutation hook bumps
 * version + invalidates by tag.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createMemoryCacheAdapter } from '../../../src/cache/memory-adapter.js';
import { cachePlugin } from '../../../src/cache/plugin/index.js';
import type { RepositoryBase } from '../../../src/repository/base.js';

type Listener = (data: unknown) => Promise<void> | void;
type ListenerEntry = { fn: Listener; priority: number };

interface MockRepo {
  hooks: Map<string, ListenerEntry[]>;
  on(event: string, fn: Listener, opts?: { priority?: number }): MockRepo;
  emit(event: string, data: unknown): Promise<void>;
}

function makeMockRepo(): MockRepo {
  const hooks = new Map<string, ListenerEntry[]>();
  const repo: MockRepo = {
    hooks,
    on(event, fn, opts) {
      const list = hooks.get(event) ?? [];
      list.push({ fn, priority: opts?.priority ?? 500 });
      list.sort((a, b) => a.priority - b.priority);
      hooks.set(event, list);
      return repo;
    },
    async emit(event, data) {
      const list = hooks.get(event) ?? [];
      for (const { fn } of list) await fn(data);
    },
  };
  return repo;
}

describe('cachePlugin — read-op cycle', () => {
  beforeEach(() => {
    vi.useFakeTimers({ now: new Date('2026-01-01T00:00:00Z') });
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('first call: before-hook stamps key, after-hook writes', async () => {
    const adapter = createMemoryCacheAdapter();
    const repo = makeMockRepo();
    const plugin = cachePlugin({
      adapter,
      enabled: ['getById'],
      defaults: { staleTime: 30 },
    });
    plugin.apply(repo as unknown as RepositoryBase);

    const context: Record<string, unknown> = {
      operation: 'getById',
      model: 'order',
      id: 'abc',
    };
    await repo.emit('before:getById', context);
    expect(context['_cacheHit']).toBeUndefined();
    expect(context['_cacheKey']).toBeTypeOf('string');

    await repo.emit('after:getById', { context, result: { id: 'abc', name: 'X' } });

    // Second call: hit
    const ctx2: Record<string, unknown> = {
      operation: 'getById',
      model: 'order',
      id: 'abc',
    };
    await repo.emit('before:getById', ctx2);
    expect(ctx2['_cacheHit']).toBe(true);
    expect(ctx2['_cachedResult']).toEqual({ id: 'abc', name: 'X' });
    expect(ctx2['_cacheStatus']).toBe('fresh');
  });

  it('respects per-call cache.enabled=false (skips read AND write)', async () => {
    const adapter = createMemoryCacheAdapter();
    const repo = makeMockRepo();
    cachePlugin({ adapter, enabled: ['getById'], defaults: { staleTime: 30 } }).apply(
      repo as unknown as RepositoryBase,
    );

    const context: Record<string, unknown> = {
      operation: 'getById',
      model: 'order',
      id: 'abc',
      cache: { enabled: false },
    };
    await repo.emit('before:getById', context);
    expect(context['_cacheKey']).toBeUndefined();
    expect(context['_cacheHit']).toBeUndefined();

    await repo.emit('after:getById', { context, result: { id: 'abc' } });
    // No write happened because the before-hook bailed early.
    const ctx2: Record<string, unknown> = {
      operation: 'getById',
      model: 'order',
      id: 'abc',
      cache: { enabled: true },
    };
    await repo.emit('before:getById', ctx2);
    expect(ctx2['_cacheHit']).toBeUndefined();
  });

  it('respects per-call cache.bypass=true (skips read but DOES write)', async () => {
    const adapter = createMemoryCacheAdapter();
    const repo = makeMockRepo();
    cachePlugin({ adapter, enabled: ['getById'], defaults: { staleTime: 30 } }).apply(
      repo as unknown as RepositoryBase,
    );

    // Pre-seed cache
    const seedCtx: Record<string, unknown> = {
      operation: 'getById',
      model: 'order',
      id: 'abc',
    };
    await repo.emit('before:getById', seedCtx);
    await repo.emit('after:getById', { context: seedCtx, result: { id: 'abc', v: 1 } });

    // Bypass call: skip read
    const bypassCtx: Record<string, unknown> = {
      operation: 'getById',
      model: 'order',
      id: 'abc',
      cache: { bypass: true },
    };
    await repo.emit('before:getById', bypassCtx);
    expect(bypassCtx['_cacheHit']).toBeUndefined();
    // …but DOES write the fresh result
    await repo.emit('after:getById', { context: bypassCtx, result: { id: 'abc', v: 2 } });

    // Next normal call sees the bypass-written value.
    const nextCtx: Record<string, unknown> = {
      operation: 'getById',
      model: 'order',
      id: 'abc',
    };
    await repo.emit('before:getById', nextCtx);
    expect(nextCtx['_cacheHit']).toBe(true);
    expect(nextCtx['_cachedResult']).toEqual({ id: 'abc', v: 2 });
  });

  it('SWR mode: stale entries serve immediately', async () => {
    const adapter = createMemoryCacheAdapter();
    const repo = makeMockRepo();
    cachePlugin({
      adapter,
      enabled: ['getById'],
      defaults: { staleTime: 30, gcTime: 60, swr: true },
    }).apply(repo as unknown as RepositoryBase);

    const ctx: Record<string, unknown> = {
      operation: 'getById',
      model: 'order',
      id: 'abc',
    };
    await repo.emit('before:getById', ctx);
    await repo.emit('after:getById', { context: ctx, result: { v: 1 } });

    vi.advanceTimersByTime(45_000); // past staleTime

    const stale: Record<string, unknown> = {
      operation: 'getById',
      model: 'order',
      id: 'abc',
    };
    await repo.emit('before:getById', stale);
    expect(stale['_cacheHit']).toBe(true);
    expect(stale['_cacheStatus']).toBe('stale');
    expect(stale['_cachedResult']).toEqual({ v: 1 });
  });
});

describe('cachePlugin — invalidation cycle', () => {
  beforeEach(() => {
    vi.useFakeTimers({ now: new Date('2026-01-01T00:00:00Z') });
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('mutation bumps model version → cached reads become unreachable', async () => {
    const adapter = createMemoryCacheAdapter();
    const repo = makeMockRepo();
    cachePlugin({
      adapter,
      enabled: ['getAll'],
      invalidating: ['create'],
      defaults: { staleTime: 60 },
    }).apply(repo as unknown as RepositoryBase);

    // Seed
    const seed: Record<string, unknown> = {
      operation: 'getAll',
      model: 'order',
      filter: { status: 'pending' },
    };
    await repo.emit('before:getAll', seed);
    await repo.emit('after:getAll', { context: seed, result: [{ id: 1 }, { id: 2 }] });

    // Mutation → version bump
    await repo.emit('after:create', {
      context: { operation: 'create', model: 'order' },
    });

    // Same logical query, but the version embedded in the key is now
    // different → cache miss.
    const after: Record<string, unknown> = {
      operation: 'getAll',
      model: 'order',
      filter: { status: 'pending' },
    };
    await repo.emit('before:getAll', after);
    expect(after['_cacheHit']).toBeUndefined();
  });

  it('mutation invalidates the model-tag — cross-aggregation invalidation works', async () => {
    const adapter = createMemoryCacheAdapter();
    const repo = makeMockRepo();
    cachePlugin({
      adapter,
      enabled: ['aggregate'],
      invalidating: ['create'],
      defaults: { staleTime: 60 },
    }).apply(repo as unknown as RepositoryBase);

    // Seed an aggregation tagged with the model name
    const aggCtx: Record<string, unknown> = {
      operation: 'aggregate',
      model: 'order',
      aggRequest: {
        measures: { count: { op: 'count' } },
        cache: { staleTime: 60, tags: ['order'] },
      },
    };
    await repo.emit('before:aggregate', aggCtx);
    await repo.emit('after:aggregate', {
      context: aggCtx,
      result: { rows: [{ count: 10 }] },
    });

    // Sanity hit
    const probe: Record<string, unknown> = {
      operation: 'aggregate',
      model: 'order',
      aggRequest: {
        measures: { count: { op: 'count' } },
        cache: { staleTime: 60, tags: ['order'] },
      },
    };
    await repo.emit('before:aggregate', probe);
    expect(probe['_cacheHit']).toBe(true);

    // Mutation auto-invalidates the model-tag
    await repo.emit('after:create', {
      context: { operation: 'create', model: 'order' },
    });

    // After mutation: the model-tag invalidation wiped the entry.
    // (Plus the version bump would also miss — both mechanisms fire.)
    const after: Record<string, unknown> = {
      operation: 'aggregate',
      model: 'order',
      aggRequest: {
        measures: { count: { op: 'count' } },
        cache: { staleTime: 60, tags: ['order'] },
      },
    };
    await repo.emit('before:aggregate', after);
    expect(after['_cacheHit']).toBeUndefined();
  });
});

describe('cachePlugin — scope-aware keys (cross-tenant safety)', () => {
  it('two callers with different organizationId get separate cache slots', async () => {
    const adapter = createMemoryCacheAdapter();
    const repo = makeMockRepo();
    cachePlugin({
      adapter,
      enabled: ['getAll'],
      defaults: { staleTime: 60 },
    }).apply(repo as unknown as RepositoryBase);

    // Tenant A
    const ctxA: Record<string, unknown> = {
      operation: 'getAll',
      model: 'order',
      filter: { organizationId: 'orgA', status: 'pending' },
    };
    await repo.emit('before:getAll', ctxA);
    await repo.emit('after:getAll', { context: ctxA, result: ['orderA1'] });

    // Tenant B — same logical query, different scope
    const ctxB: Record<string, unknown> = {
      operation: 'getAll',
      model: 'order',
      filter: { organizationId: 'orgB', status: 'pending' },
    };
    await repo.emit('before:getAll', ctxB);
    expect(ctxB['_cacheHit']).toBeUndefined();
  });

  it('autoTagsFromScope=false suppresses scope-tag injection', async () => {
    const adapter = createMemoryCacheAdapter();
    const repo = makeMockRepo();
    cachePlugin({
      adapter,
      enabled: ['getAll'],
      defaults: { staleTime: 60 },
      autoTagsFromScope: false,
    }).apply(repo as unknown as RepositoryBase);

    // With auto-tagging off, the only difference between two tenants'
    // requests is the filter shape — which IS in the params hash, so
    // they STILL get separate slots. (Auto-tagging affects the tag
    // SIDE-INDEX, not the primary key derivation.)
    const ctxA: Record<string, unknown> = {
      operation: 'getAll',
      model: 'order',
      filter: { organizationId: 'orgA' },
    };
    await repo.emit('before:getAll', ctxA);
    await repo.emit('after:getAll', { context: ctxA, result: ['rA'] });

    const ctxB: Record<string, unknown> = {
      operation: 'getAll',
      model: 'order',
      filter: { organizationId: 'orgB' },
    };
    await repo.emit('before:getAll', ctxB);
    expect(ctxB['_cacheHit']).toBeUndefined();
  });
});

describe('cachePlugin — exposed handle', () => {
  it('attaches `repo.cache` handle for kit-side delegation', () => {
    const adapter = createMemoryCacheAdapter();
    const repo = makeMockRepo() as MockRepo & { cache?: unknown };
    cachePlugin({ adapter }).apply(repo as unknown as RepositoryBase);
    expect(repo.cache).toBeDefined();
    expect(typeof (repo.cache as { invalidateByTags: unknown }).invalidateByTags).toBe('function');
    expect(typeof (repo.cache as { bumpModelVersion: unknown }).bumpModelVersion).toBe('function');
  });

  it('handle.invalidateByTags wires through to the engine', async () => {
    const adapter = createMemoryCacheAdapter();
    const repo = makeMockRepo() as MockRepo & {
      cache?: { invalidateByTags(tags: readonly string[]): Promise<number> };
    };
    cachePlugin({
      adapter,
      enabled: ['getAll'],
      defaults: { staleTime: 60 },
    }).apply(repo as unknown as RepositoryBase);

    // Seed an entry tagged 'orders'
    const ctx: Record<string, unknown> = {
      operation: 'getAll',
      model: 'order',
      filter: { status: 'a' },
      cache: { staleTime: 60, tags: ['orders'] },
    };
    await (repo as unknown as MockRepo).emit('before:getAll', ctx);
    await (repo as unknown as MockRepo).emit('after:getAll', {
      context: ctx,
      result: ['x'],
    });

    const removed = await repo.cache!.invalidateByTags(['orders']);
    expect(removed).toBeGreaterThanOrEqual(1);
  });
});

// ──────────────────────────────────────────────────────────────────────
// Per-scope version-bump (TanStack-style targeted invalidation)
// ──────────────────────────────────────────────────────────────────────

describe('cachePlugin — per-scope version-bump (cross-tenant isolation)', () => {
  it('write in tenant A does NOT invalidate tenant B cached read', async () => {
    const adapter = createMemoryCacheAdapter();
    const repo = makeMockRepo();
    cachePlugin({
      adapter,
      enabled: ['getAll'],
      invalidating: ['create'],
      defaults: { staleTime: 60 },
    }).apply(repo as unknown as RepositoryBase);

    // Tenant B caches a query
    const bRead: Record<string, unknown> = {
      operation: 'getAll',
      model: 'order',
      filter: { organizationId: 'orgB', status: 'pending' },
    };
    await repo.emit('before:getAll', bRead);
    await repo.emit('after:getAll', { context: bRead, result: ['orderB1'] });

    // Tenant A WRITES — bumps only org:orgA's version
    await repo.emit('after:create', {
      context: { operation: 'create', model: 'order', filter: { organizationId: 'orgA' } },
    });

    // Tenant B reads again — should still HIT (org:orgB's version untouched)
    const bReadAfter: Record<string, unknown> = {
      operation: 'getAll',
      model: 'order',
      filter: { organizationId: 'orgB', status: 'pending' },
    };
    await repo.emit('before:getAll', bReadAfter);
    expect(bReadAfter['_cacheHit']).toBe(true);
  });

  it('write in tenant A DOES invalidate tenant A cached read', async () => {
    const adapter = createMemoryCacheAdapter();
    const repo = makeMockRepo();
    cachePlugin({
      adapter,
      enabled: ['getAll'],
      invalidating: ['create'],
      defaults: { staleTime: 60 },
    }).apply(repo as unknown as RepositoryBase);

    // Tenant A caches
    const aRead: Record<string, unknown> = {
      operation: 'getAll',
      model: 'order',
      filter: { organizationId: 'orgA', status: 'pending' },
    };
    await repo.emit('before:getAll', aRead);
    await repo.emit('after:getAll', { context: aRead, result: ['orderA1'] });

    // Tenant A writes — bumps org:orgA's version
    await repo.emit('after:create', {
      context: { operation: 'create', model: 'order', filter: { organizationId: 'orgA' } },
    });

    // Tenant A reads again — should MISS (own version bumped)
    const aReadAfter: Record<string, unknown> = {
      operation: 'getAll',
      model: 'order',
      filter: { organizationId: 'orgA', status: 'pending' },
    };
    await repo.emit('before:getAll', aReadAfter);
    expect(aReadAfter['_cacheHit']).toBeUndefined();
  });
});

// ──────────────────────────────────────────────────────────────────────
// Single-flight integration (cache-stampede dedup at the plugin level)
// ──────────────────────────────────────────────────────────────────────

describe('cachePlugin — single-flight on miss', () => {
  /**
   * `setImmediate` drains the microtask queue + one event-loop tick.
   * Used here to ensure the waiter has reached `await claim.promise`
   * BEFORE we resolve the pending entry — otherwise we'd race the
   * waiter and resolve before it can join the wait queue.
   */
  const drainMicrotasks = () => new Promise<void>((r) => setImmediate(r));

  /**
   * The single-flight engine API itself is exhaustively tested in
   * `single-flight.test.ts`. These plugin-level tests verify the
   * before/after-hook wiring around it.
   */
  it('coalesces on an existing in-flight claim and stamps _cacheCoalesced', async () => {
    const adapter = createMemoryCacheAdapter();
    const repo = makeMockRepo() as MockRepo & {
      cache?: {
        engine: {
          claimPending<_T>(key: string): unknown;
          resolvePending<T>(key: string, value: T): void;
        };
      };
    };
    let coalesces = 0;
    cachePlugin({
      adapter,
      enabled: ['getById'],
      defaults: { staleTime: 60 },
      log: {
        onCoalesce: () => {
          coalesces++;
        },
      },
    }).apply(repo as unknown as RepositoryBase);

    // First, run a before-hook to discover the cache key the plugin
    // would compute — and bypass single-flight by NOT awaiting the
    // result. Use the cache.engine handle to pre-claim that key.
    const probeCtx: Record<string, unknown> = { operation: 'getById', model: 'order', id: 'abc' };
    await repo.emit('before:getById', probeCtx);
    const key = probeCtx['_cacheKey'] as string;
    expect(typeof key).toBe('string');

    // Probe was the FIRST claimer — the slot is now pending. Now a
    // second caller arrives with the same params and must coalesce.
    const waiterCtx: Record<string, unknown> = { operation: 'getById', model: 'order', id: 'abc' };
    const waiterDone = repo.emit('before:getById', waiterCtx);

    // Drain microtasks so the waiter reaches `await claim.promise`
    // before we resolve — otherwise we'd race and resolve the deferred
    // before the waiter joins it.
    await drainMicrotasks();

    // Resolve the probe's claim — waiter unblocks with the coalesced result.
    repo.cache!.engine.resolvePending(key, { id: 'abc', v: 99 });
    await waiterDone;

    expect(waiterCtx['_cacheHit']).toBe(true);
    expect(waiterCtx['_cacheCoalesced']).toBe(true);
    expect(waiterCtx['_cachedResult']).toEqual({ id: 'abc', v: 99 });
    expect(waiterCtx['_cacheStatus']).toBe('fresh');
    expect(coalesces).toBe(1);
  });

  it('error:<op> rejects pending — waiter falls through (no inline retry)', async () => {
    const adapter = createMemoryCacheAdapter();
    const repo = makeMockRepo() as MockRepo & {
      cache?: { engine: { rejectPending(key: string, err: unknown): void } };
    };
    cachePlugin({
      adapter,
      enabled: ['getById'],
      defaults: { staleTime: 60 },
    }).apply(repo as unknown as RepositoryBase);

    // Probe to discover the key + claim the slot.
    const probeCtx: Record<string, unknown> = { operation: 'getById', model: 'order', id: 'fail' };
    await repo.emit('before:getById', probeCtx);

    // Waiter arrives + reaches `await claim.promise` (via microtask drain).
    const waiterCtx: Record<string, unknown> = { operation: 'getById', model: 'order', id: 'fail' };
    const waiterDone = repo.emit('before:getById', waiterCtx);
    await drainMicrotasks();

    // Probe's executor errors — error:<op> fires; plugin calls rejectPending.
    await repo.emit('error:getById', { context: probeCtx, error: new Error('upstream') });
    await waiterDone;

    // Waiter caught the rejection silently and fell through — _cacheHit not set.
    expect(waiterCtx['_cacheHit']).toBeUndefined();
  });

  it('bypass: true does NOT participate in single-flight (always runs fresh)', async () => {
    const adapter = createMemoryCacheAdapter();
    const repo = makeMockRepo();
    cachePlugin({
      adapter,
      enabled: ['getById'],
      defaults: { staleTime: 60 },
    }).apply(repo as unknown as RepositoryBase);

    // First caller claims (normal path).
    const ctx1: Record<string, unknown> = { operation: 'getById', model: 'order', id: 'x' };
    await repo.emit('before:getById', ctx1);

    // Bypass caller skips single-flight entirely — runs fresh.
    const bypassCtx: Record<string, unknown> = {
      operation: 'getById',
      model: 'order',
      id: 'x',
      cache: { bypass: true },
    };
    await repo.emit('before:getById', bypassCtx);
    expect(bypassCtx['_cacheHit']).toBeUndefined();
    expect(bypassCtx['_cacheCoalesced']).toBeUndefined();
  });
});
