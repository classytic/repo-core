/**
 * `runUsageStoreContract` — cross-kit usage-store contract suite.
 *
 * Wires a kit-specific harness to the canonical scenarios every
 * `UsageStore` implementation must pass — so "swap mongokit/usage for
 * sqlitekit/usage" is a provable claim and drift shows up here before
 * it ships. Written ONCE here; kits import it instead of hand-writing
 * conformance (same shape as `runLockAdapterConformance`).
 *
 * ## Usage from a kit
 *
 *     import { runUsageStoreContract } from '@classytic/repo-core/testing';
 *     import { createMongoUsageStore } from '../../src/usage/index.js';
 *
 *     describe('mongokit/usage conformance', () => {
 *       runUsageStoreContract({
 *         createStore: () => createMongoUsageStore({ connection }),
 *         async beforeEach() { await clearCounters(); },
 *       });
 *     });
 */

import { beforeEach, describe, expect, it } from 'vitest';
import type { UsageStore } from '../usage/index.js';

export interface UsageConformanceHarness {
  /**
   * Construct the store under test. May be async (SQL migrations,
   * index creation). The same instance is shared by every test —
   * `beforeEach` clears residual counters.
   */
  createStore(): UsageStore | Promise<UsageStore>;

  /**
   * Wipe every counter between tests. Mongo: `deleteMany({})`.
   * SQL: `DELETE FROM kit_usage`. Memory: `clear()`.
   */
  beforeEach?(store: UsageStore): void | Promise<void>;
}

export function runUsageStoreContract(harness: UsageConformanceHarness): void {
  describe('UsageStore contract', () => {
    let store: UsageStore;

    beforeEach(async () => {
      store = await harness.createStore();
      await harness.beforeEach?.(store);
    });

    it('accumulates increments per (actor, period, kind)', async () => {
      const bucket = { actor: 'org-1', period: '2026-07', kind: 'api.requests' };
      await store.increment(bucket, 1);
      await store.increment(bucket, 2);
      await store.increment({ ...bucket, kind: 'ai.tokens.input' }, 500);

      expect(await store.summary('org-1', '2026-07')).toEqual({
        'api.requests': 3,
        'ai.tokens.input': 500,
      });
    });

    it('treats a missing bucket as 0 (first increment creates it)', async () => {
      await store.increment({ actor: 'a', period: '2026-07', kind: 'k' }, 7);
      expect(await store.summary('a', '2026-07')).toEqual({ k: 7 });
    });

    it('isolates actors and periods', async () => {
      await store.increment({ actor: 'org-1', period: '2026-06', kind: 'k' }, 5);
      await store.increment({ actor: 'org-1', period: '2026-07', kind: 'k' }, 7);
      await store.increment({ actor: 'org-2', period: '2026-07', kind: 'k' }, 11);

      expect(await store.summary('org-1', '2026-06')).toEqual({ k: 5 });
      expect(await store.summary('org-1', '2026-07')).toEqual({ k: 7 });
      expect(await store.summary('org-2', '2026-07')).toEqual({ k: 11 });
    });

    it('dotted kind names round-trip exactly (no path nesting)', async () => {
      await store.increment({ actor: 'a', period: '2026-07', kind: 'storage.egress.bytes' }, 42);
      const summary = await store.summary('a', '2026-07');
      expect(summary['storage.egress.bytes']).toBe(42);
      expect(Object.keys(summary)).toEqual(['storage.egress.bytes']);
    });

    it('returns {} for unknown actors/periods (never throws)', async () => {
      expect(await store.summary('nobody', '2099-01')).toEqual({});
    });

    it('increment is atomic per bucket under concurrency', async () => {
      const bucket = { actor: 'org-c', period: '2026-07', kind: 'api.requests' };
      await Promise.all(Array.from({ length: 50 }, () => store.increment(bucket, 1)));
      expect((await store.summary('org-c', '2026-07'))['api.requests']).toBe(50);
    });
  });
}
