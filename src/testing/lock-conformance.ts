/**
 * `runLockAdapterConformance` — cross-kit lock-adapter contract suite.
 *
 * Wires a kit-specific `LockConformanceHarness` to a canonical set of
 * scenarios that every `LockAdapter` implementation should pass. The
 * goal is parity: "swap mongokit/lock for sqlitekit/lock" must be a
 * provable claim, and behavior drift between backends shows up here
 * before it ships.
 *
 * Mirrors `runStandardRepoConformance` in shape — vitest is imported
 * at top of file (this subpath is test-only) and the harness gives
 * the kit one chance to construct the adapter, then handles cleanup
 * between scenarios.
 *
 * ## Usage from a kit
 *
 *     import { runLockAdapterConformance } from '@classytic/repo-core/testing';
 *     import { createMongoLockAdapter } from '../../src/lock/index.js';
 *
 *     describe('mongokit/lock conformance', () => {
 *       runLockAdapterConformance({
 *         createAdapter: () => createMongoLockAdapter({ collectionName: 'lock_conformance' }),
 *         async beforeEach() { await clearLocks(); },
 *       });
 *     });
 */

import { beforeEach, describe, expect, it } from 'vitest';
import type { LockAdapter } from '../lock/index.js';

export interface LockConformanceHarness {
  /**
   * Construct a fresh adapter for each describe block. May be async
   * (e.g. SQL adapters that need to run a CREATE TABLE migration).
   * The same adapter instance is shared by every test in the suite —
   * `beforeEach` is responsible for clearing residual lock state.
   */
  createAdapter(): LockAdapter | Promise<LockAdapter>;

  /**
   * Wipe every lock between tests. Mongo: drop the collection.
   * SQLite: `DELETE FROM kit_locks`. Memory: noop (factory returns
   * a fresh `Map`).
   *
   * Required because tests share an adapter and acquire under
   * conflicting names. A leaked lock from one test breaks the
   * "first acquire wins" invariant in the next.
   */
  beforeEach?(adapter: LockAdapter): void | Promise<void>;
}

const A = 'replica-A';
const B = 'replica-B';

export function runLockAdapterConformance(harness: LockConformanceHarness): void {
  describe('LockAdapter contract', () => {
    let adapter: LockAdapter;

    beforeEach(async () => {
      adapter = await harness.createAdapter();
      await harness.beforeEach?.(adapter);
    });

    describe('tryAcquire', () => {
      it('first acquire wins on a free lock', async () => {
        expect(await adapter.tryAcquire('cron.outbox', A, 5_000)).toBe(true);
      });

      it('second acquire by a different holder fails while the first is live', async () => {
        await adapter.tryAcquire('cron.outbox', A, 5_000);
        expect(await adapter.tryAcquire('cron.outbox', B, 5_000)).toBe(false);
      });

      it('same holder may extend (idempotent re-acquire)', async () => {
        expect(await adapter.tryAcquire('cron.outbox', A, 5_000)).toBe(true);
        expect(await adapter.tryAcquire('cron.outbox', A, 5_000)).toBe(true);
      });

      it('expired lease is reclaimable by another holder', async () => {
        // 1ms lease + 10ms wait > expiry. Sized so even a slow CI
        // doesn't keep the lease "live" by accident.
        expect(await adapter.tryAcquire('cron.outbox', A, 1)).toBe(true);
        await sleep(10);
        expect(await adapter.tryAcquire('cron.outbox', B, 5_000)).toBe(true);
        // A is locked out — B owns it now.
        expect(await adapter.tryAcquire('cron.outbox', A, 5_000)).toBe(false);
      });

      it('different lock names are independent', async () => {
        expect(await adapter.tryAcquire('lock.one', A, 5_000)).toBe(true);
        // Different name → A can grab it too.
        expect(await adapter.tryAcquire('lock.two', A, 5_000)).toBe(true);
        // B is still locked out from the first.
        expect(await adapter.tryAcquire('lock.one', B, 5_000)).toBe(false);
      });

      it('parallel acquires resolve to exactly one winner', async () => {
        // The race-safety claim: a freshly-empty lock with two
        // simultaneous acquires produces ONE true and ONE false.
        const results = await Promise.all([
          adapter.tryAcquire('shared.name', A, 5_000),
          adapter.tryAcquire('shared.name', B, 5_000),
        ]);
        expect(results.filter((r) => r === true)).toHaveLength(1);
      });
    });

    describe('release', () => {
      it('the holder can release their own lock', async () => {
        await adapter.tryAcquire('cron.outbox', A, 5_000);
        expect(await adapter.release('cron.outbox', A)).toBe(true);
      });

      it('a non-holder cannot release', async () => {
        await adapter.tryAcquire('cron.outbox', A, 5_000);
        expect(await adapter.release('cron.outbox', B)).toBe(false);
      });

      it('release on an unheld lock returns false (idempotent)', async () => {
        expect(await adapter.release('never.acquired', A)).toBe(false);
      });

      it('after release, another holder can acquire', async () => {
        await adapter.tryAcquire('cron.outbox', A, 5_000);
        await adapter.release('cron.outbox', A);
        expect(await adapter.tryAcquire('cron.outbox', B, 5_000)).toBe(true);
      });

      it('repeated release by the same holder returns false on the second call', async () => {
        await adapter.tryAcquire('cron.outbox', A, 5_000);
        expect(await adapter.release('cron.outbox', A)).toBe(true);
        expect(await adapter.release('cron.outbox', A)).toBe(false);
      });
    });

    describe('inspect', () => {
      it('reports the current holder for a live lock', async () => {
        if (!adapter.inspect) return; // optional method
        await adapter.tryAcquire('cron.outbox', A, 5_000);
        const state = await adapter.inspect('cron.outbox');
        expect(state).toBeTruthy();
        expect(state?.name).toBe('cron.outbox');
        expect(state?.holder).toBe(A);
        expect(state?.expiresAt).toBeInstanceOf(Date);
        expect(state?.acquiredAt).toBeInstanceOf(Date);
      });

      it('returns null for a never-acquired lock', async () => {
        if (!adapter.inspect) return;
        expect(await adapter.inspect('never.acquired')).toBeNull();
      });

      it('returns null for an expired lock (treats expired as absent)', async () => {
        if (!adapter.inspect) return;
        await adapter.tryAcquire('cron.outbox', A, 1);
        await sleep(10);
        expect(await adapter.inspect('cron.outbox')).toBeNull();
      });

      it('preserves acquiredAt across same-holder extensions', async () => {
        if (!adapter.inspect) return;
        await adapter.tryAcquire('cron.outbox', A, 5_000);
        const original = (await adapter.inspect('cron.outbox'))?.acquiredAt;
        await sleep(5);
        await adapter.tryAcquire('cron.outbox', A, 5_000);
        const extended = (await adapter.inspect('cron.outbox'))?.acquiredAt;
        expect(extended?.getTime()).toBe(original?.getTime());
      });
    });

    describe('post-steal semantics', () => {
      it('the original holder cannot release after a steal', async () => {
        // A acquires, lease expires, B steals — A's release should
        // fail because A no longer owns the lock. Without this
        // CAS-on-holder check, A could blow away B's live lease.
        await adapter.tryAcquire('cron.outbox', A, 1);
        await sleep(10);
        await adapter.tryAcquire('cron.outbox', B, 5_000);
        expect(await adapter.release('cron.outbox', A)).toBe(false);
        // B's lock is intact.
        if (adapter.inspect) {
          const state = await adapter.inspect('cron.outbox');
          expect(state?.holder).toBe(B);
        }
      });
    });

    describe('stress', () => {
      it('50 concurrent holders against one name → exactly one winner', async () => {
        // The atomicity claim under genuine load. 50 acquires fired
        // simultaneously must produce exactly 1 `true` and 49
        // `false`. A read-then-write split would let 2+ win; this
        // test fails fast if the adapter regresses to that shape.
        const holders = Array.from({ length: 50 }, (_, i) => `replica-${i}`);
        const results = await Promise.all(
          holders.map((h) => adapter.tryAcquire('contended', h, 5_000)),
        );
        expect(results.filter((r) => r === true)).toHaveLength(1);
      });

      it('100 sequential acquire/release cycles leave no residue', async () => {
        // Catches leaks: a buggy adapter that fails to clean up on
        // release (or sets state with the wrong key encoding) would
        // accumulate stale entries that block fresh acquires after
        // a few cycles.
        for (let i = 0; i < 100; i++) {
          expect(await adapter.tryAcquire('cycled', A, 5_000)).toBe(true);
          expect(await adapter.release('cycled', A)).toBe(true);
        }
        // After all cycles, the lock is genuinely free — a different
        // holder grabs it cleanly.
        expect(await adapter.tryAcquire('cycled', B, 5_000)).toBe(true);
      });

      it('100 same-holder extensions preserve the original acquiredAt', async () => {
        // Diagnostics rely on `acquiredAt` reporting "lock has been
        // held since X." If extensions silently overwrite it, ops
        // can't tell a long-running holder from a fast-flapping one.
        if (!adapter.inspect) return;
        await adapter.tryAcquire('extended', A, 5_000);
        const original = (await adapter.inspect('extended'))?.acquiredAt;
        expect(original).toBeTruthy();
        for (let i = 0; i < 100; i++) {
          await adapter.tryAcquire('extended', A, 5_000);
        }
        const final = (await adapter.inspect('extended'))?.acquiredAt;
        expect(final?.getTime()).toBe(original?.getTime());
      });

      it('ownership churn: A → B → C → A handovers each succeed atomically', async () => {
        // Each handover must complete cleanly: prior holder
        // releases, new holder acquires fresh. A buggy CAS that
        // looks at the doc shape (instead of the holder field) could
        // let a stale holder reclaim mid-transition.
        const C = 'replica-C';
        for (const holder of [A, B, C, A]) {
          expect(await adapter.tryAcquire('churn', holder, 5_000)).toBe(true);
          expect(await adapter.release('churn', holder)).toBe(true);
        }
      });
    });
  });
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}
