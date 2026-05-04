/**
 * Bench: CacheEngine hot-path latencies on the in-memory adapter.
 *
 * These numbers measure the engine itself + the in-memory adapter
 * combined — Redis-backed adapters add a network RTT on every adapter
 * call but the engine's own overhead is unchanged. Use these as a
 * floor for "what the engine adds on top of the adapter" reasoning.
 *
 * Bench-only file. Skipped in `vitest run`; runs under `vitest bench`.
 *
 * NOTE: vitest 4's bench mode does NOT execute `beforeAll` / `beforeEach`
 * hooks. We initialize all bench state at module load (top-level await
 * is fine — vitest awaits the bench file before running) and reuse it
 * across the bench loop bodies.
 */

import { bench, describe } from 'vitest';
import { CacheEngine } from '../../src/cache/engine.js';
import { createMemoryCacheAdapter } from '../../src/cache/memory-adapter.js';
import { type ResolvedCacheOptions, resolveCacheOptions } from '../../src/cache/options.js';

function resolved(o: Record<string, unknown> = {}): ResolvedCacheOptions {
  return resolveCacheOptions(o, undefined, undefined);
}

const noTagOpts = resolved({ staleTime: 60, gcTime: 600 });
const fiveTagOpts = resolved({
  staleTime: 60,
  gcTime: 600,
  tags: ['org:abc123', 'user:42', 'orders', 'list', 'page:1'],
});

// ── Read-path engines (top-level setup; bench mode skips beforeAll) ──

const engineHit = new CacheEngine(createMemoryCacheAdapter());
await engineHit.set('hot-key', { id: 1, name: 'sample', items: [1, 2, 3] }, noTagOpts);

const engineMiss = new CacheEngine(createMemoryCacheAdapter());

describe('CacheEngine — read paths', () => {
  bench('engine.get HIT (fresh)', async () => {
    await engineHit.get('hot-key', noTagOpts);
  });

  bench('engine.get MISS (empty cache)', async () => {
    await engineMiss.get('cold-key', noTagOpts);
  });
});

// ── Write-path engines ─────────────────────────────────────────────

const engineNoTags = new CacheEngine(createMemoryCacheAdapter());
const engineWithTags = new CacheEngine(createMemoryCacheAdapter());
let writeCounter = 0;

describe('CacheEngine — write paths', () => {
  bench('engine.set without tags', async () => {
    writeCounter++;
    await engineNoTags.set(`k:${writeCounter}`, { id: writeCounter, payload: 'data' }, noTagOpts);
  });

  bench('engine.set with 5 tags', async () => {
    writeCounter++;
    await engineWithTags.set(
      `k:${writeCounter}`,
      { id: writeCounter, payload: 'data' },
      fiveTagOpts,
    );
  });
});

// ── Single-flight ──────────────────────────────────────────────────

const sfEngine = new CacheEngine(createMemoryCacheAdapter());
let sfCounter = 0;

describe('CacheEngine — single-flight', () => {
  bench('claimPending + resolvePending roundtrip', () => {
    const key = `sf:${sfCounter++}`;
    const claim = sfEngine.claimPending<number>(key);
    if (claim.status === 'claimed') {
      sfEngine.resolvePending(key, 1);
    }
  });
});

// ── Invalidation (engine + 100 entries primed inside the body) ─────

const invalidationTags = Array.from({ length: 10 }, (_, i) => `tag:${i}`);

describe('CacheEngine — invalidation', () => {
  // Vitest bench runs the same body in a tight loop. To keep iterations
  // comparable we re-prime the adapter inside the body — that overstates
  // the per-op cost (setup dominates a single op) but tracks fan-out
  // cost correctly because both prime + invalidate scale linearly with N.
  bench(
    'invalidateByTags (10 tags × 100 entries, includes setup)',
    async () => {
      const engine = new CacheEngine(createMemoryCacheAdapter());
      for (let i = 0; i < 100; i++) {
        await engine.set(
          `entry:${i}`,
          { i },
          resolved({ staleTime: 60, gcTime: 600, tags: invalidationTags }),
        );
      }
      await engine.invalidateByTags(invalidationTags);
    },
    { iterations: 200, warmupIterations: 5 },
  );
});

// ── Version-bump ───────────────────────────────────────────────────

const versionEngine = new CacheEngine(createMemoryCacheAdapter());

describe('CacheEngine — version-bump', () => {
  bench('bumpModelVersion (atomic increment path)', async () => {
    await versionEngine.bumpVersion('orders', 'org:abc');
  });
});
