/**
 * `runStandardRepoConformance` — the cross-kit contract suite.
 *
 * Wires a kit-specific `ConformanceHarness` to a canonical set of
 * scenarios that every `StandardRepo<TDoc>` implementation should pass.
 * Each describe block probes one behavior of the contract; scenarios
 * the backend doesn't support (D1 transactions, Mongo standalone
 * transactions, optional methods) are `it.skip`ped via feature flags.
 *
 * The goal is to make "swap mongokit for sqlitekit" a provable claim:
 * when both kits' conformance suites stay green, controller code can
 * move between backends without behavior drift.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { and, eq, gt, in_, isNull, like, ne, or } from '../filter/index.js';
import type { OffsetPaginationResult } from '../pagination/types.js';
import type { KeysetAggPaginationResult } from '../repository/types.js';
import type { ConformanceContext, ConformanceDoc, ConformanceHarness } from './types.js';

// ──────────────────────────────────────────────────────────────────────
// Helpers
// ──────────────────────────────────────────────────────────────────────

/** Read the primary key from a doc regardless of backend convention. */
function idOf<TDoc extends ConformanceDoc>(
  doc: TDoc | null | undefined,
  idField: string,
): string | undefined {
  if (!doc) return undefined;
  const value = (doc as Record<string, unknown>)[idField];
  return value == null ? undefined : String(value);
}

/** ISO timestamp N seconds offset from now — deterministic ordering fixture. */
function isoAt(offsetSeconds: number): string {
  return new Date(Date.UTC(2026, 3, 1) + offsetSeconds * 1000).toISOString();
}

// ──────────────────────────────────────────────────────────────────────
// Main entry
// ──────────────────────────────────────────────────────────────────────

export function runStandardRepoConformance<TDoc extends ConformanceDoc = ConformanceDoc>(
  harness: ConformanceHarness<TDoc>,
): void {
  // Gate helpers — read once at suite-build time for `it.skipIf`.
  // Each gate is `true` when the feature should be tested. The
  // top-level `aggregate` flag is required for any aggregate
  // scenario; per-op flags AND-into the top-level gate so a kit
  // that flips `aggregate: false` skips all of them with one switch.
  const ops = harness.features.aggregateOps;
  const aggGate = harness.features.aggregate;
  const skipNoAgg = !aggGate;
  const skipNoTopN = !aggGate || !ops?.topN;
  const skipNoPercentile = !aggGate || !ops?.percentile;
  const skipNoCustomBuckets = !aggGate || !ops?.customDateBuckets;
  const skipNoSubMinuteBuckets = !aggGate || !ops?.dateBucketSubMinute;
  const skipNoStddev = !aggGate || !ops?.stddev;
  const skipNoCache = !aggGate || !ops?.cache;
  const skipNoPurge = !harness.features.purgeByField;

  describe(`[conformance] ${harness.name}`, () => {
    let ctx: ConformanceContext<TDoc>;

    beforeEach(async () => {
      ctx = await harness.setup();
    });

    afterEach(async () => {
      await ctx.cleanup();
    });

    // ──────────────────────────────────────────────────────────────────
    // CRUD basics — MinimalRepo floor
    // ──────────────────────────────────────────────────────────────────

    describe('CRUD basics', () => {
      it('create → getById round-trips all scalar fields', async () => {
        const input = harness.makeDoc({
          name: 'Alice',
          email: 'alice@example.com',
          category: 'admin',
          count: 42,
          active: true,
          notes: 'seed note',
          createdAt: isoAt(0),
        });
        const created = await ctx.repo.create(input);
        const id = idOf(created, harness.idField);
        expect(id).toBeDefined();

        const fetched = await ctx.repo.getById(id!);
        expect(fetched).not.toBeNull();
        expect(fetched?.name).toBe('Alice');
        expect(fetched?.email).toBe('alice@example.com');
        expect(fetched?.category).toBe('admin');
        expect(fetched?.count).toBe(42);
        expect(fetched?.active).toBe(true);
        expect(fetched?.notes).toBe('seed note');
        expect(fetched?.createdAt).toBe(isoAt(0));
      });

      it('getById miss returns null', async () => {
        const result = await ctx.repo.getById('does-not-exist-xyz');
        expect(result).toBeNull();
      });

      it('update by id returns updated doc; miss returns null', async () => {
        const created = await ctx.repo.create(harness.makeDoc({ name: 'Bob', count: 1 }));
        const id = idOf(created, harness.idField)!;

        const updated = await ctx.repo.update(id, { count: 99 } as Partial<TDoc>);
        expect(updated?.count).toBe(99);

        const miss = await ctx.repo.update('no-such-id', { count: 1 } as Partial<TDoc>);
        expect(miss).toBeNull();
      });

      it('delete by id succeeds; second delete returns null (miss)', async () => {
        const created = await ctx.repo.create(harness.makeDoc({ name: 'Carol' }));
        const id = idOf(created, harness.idField)!;

        const first = await ctx.repo.delete(id);
        expect(first).not.toBeNull();
        expect(first?.message).toBeDefined();

        const second = await ctx.repo.delete(id);
        expect(second).toBeNull();
      });
    });

    // ──────────────────────────────────────────────────────────────────
    // findOneAndUpdate — atomic CAS
    // ──────────────────────────────────────────────────────────────────

    describe('findOneAndUpdate', () => {
      beforeEach(async () => {
        await ctx.repo.createMany!([
          harness.makeDoc({
            name: 'u1',
            email: 'u1@x.com',
            category: 'reader',
            createdAt: isoAt(1),
          }),
          harness.makeDoc({
            name: 'u2',
            email: 'u2@x.com',
            category: 'reader',
            createdAt: isoAt(2),
          }),
          harness.makeDoc({
            name: 'u3',
            email: 'u3@x.com',
            category: 'reader',
            createdAt: isoAt(3),
          }),
        ]);
      });

      it('sort claims oldest row first (FIFO)', async () => {
        if (!ctx.repo.findOneAndUpdate) return;
        const claimed = await ctx.repo.findOneAndUpdate(
          { category: 'reader' },
          { category: 'claimed' },
          { sort: { createdAt: 1 } },
        );
        expect(claimed?.name).toBe('u1');
        expect(claimed?.category).toBe('claimed');
      });

      it('returnDocument: "before" returns pre-update state', async () => {
        if (!ctx.repo.findOneAndUpdate) return;
        const before = await ctx.repo.findOneAndUpdate(
          { name: 'u2' },
          { category: 'archived' },
          { returnDocument: 'before' },
        );
        expect(before?.category).toBe('reader');
      });

      it('no match, no upsert → returns null', async () => {
        if (!ctx.repo.findOneAndUpdate) return;
        const result = await ctx.repo.findOneAndUpdate(
          { name: 'does-not-exist' },
          { category: 'x' },
        );
        expect(result).toBeNull();
      });

      it.skipIf(!harness.features.upsert)('upsert inserts when no row matches', async () => {
        if (!ctx.repo.findOneAndUpdate) return;
        const inserted = await ctx.repo.findOneAndUpdate(
          { email: 'brand-new@x.com' },
          harness.makeDoc({
            name: 'Zed',
            email: 'brand-new@x.com',
            category: 'reader',
            createdAt: isoAt(100),
          }),
          { upsert: true },
        );
        expect(inserted?.name).toBe('Zed');
        expect(inserted?.email).toBe('brand-new@x.com');
      });
    });

    // ──────────────────────────────────────────────────────────────────
    // updateMany / deleteMany
    // ──────────────────────────────────────────────────────────────────

    describe('updateMany / deleteMany', () => {
      beforeEach(async () => {
        await ctx.repo.createMany!([
          harness.makeDoc({ name: 'a', category: 'reader', count: 1 }),
          harness.makeDoc({ name: 'b', category: 'reader', count: 2 }),
          harness.makeDoc({ name: 'c', category: 'admin', count: 3 }),
        ]);
      });

      it('updateMany affects only matching rows', async () => {
        if (!ctx.repo.updateMany) return;
        const result = await ctx.repo.updateMany(
          { category: 'reader' },
          { category: 'former-reader' },
        );
        expect(result.matchedCount).toBe(2);
        expect(result.modifiedCount).toBe(2);

        const admins = await ctx.repo.findAll!({ category: 'admin' });
        expect(admins).toHaveLength(1);
      });

      it('updateMany with no match returns matchedCount 0', async () => {
        if (!ctx.repo.updateMany) return;
        const result = await ctx.repo.updateMany({ category: 'nonexistent' }, { category: 'x' });
        expect(result.matchedCount).toBe(0);
        expect(result.modifiedCount).toBe(0);
      });

      it('deleteMany removes matching rows and reports count', async () => {
        if (!ctx.repo.deleteMany) return;
        const result = await ctx.repo.deleteMany({ category: 'reader' }, { mode: 'hard' });
        expect(result.deletedCount).toBe(2);
        const remaining = await ctx.repo.findAll!();
        expect(remaining).toHaveLength(1);
      });

      it('deleteMany with empty match returns deletedCount 0', async () => {
        if (!ctx.repo.deleteMany) return;
        const result = await ctx.repo.deleteMany({ category: 'nope' }, { mode: 'hard' });
        expect(result.deletedCount).toBe(0);
      });
    });

    // ──────────────────────────────────────────────────────────────────
    // distinct / count / exists
    // ──────────────────────────────────────────────────────────────────

    describe('projections', () => {
      beforeEach(async () => {
        await ctx.repo.createMany!([
          harness.makeDoc({ name: 'a', category: 'reader' }),
          harness.makeDoc({ name: 'b', category: 'reader' }),
          harness.makeDoc({ name: 'c', category: 'admin' }),
          harness.makeDoc({ name: 'd', category: null }),
          harness.makeDoc({ name: 'e', category: null }),
        ]);
      });

      it.skipIf(!harness.features.distinct)(
        'distinct returns each unique value exactly once',
        async () => {
          if (!ctx.repo.distinct) return;
          const categories = await ctx.repo.distinct<string | null>('category');
          const set = new Set(categories);
          // Every backend should include 'reader' and 'admin' exactly once.
          expect(set.has('reader')).toBe(true);
          expect(set.has('admin')).toBe(true);
          // Null handling: backends either include null or omit it — both
          // are common. Assert that it appears at most once if present.
          const nullCount = categories.filter((v) => v === null).length;
          expect(nullCount).toBeLessThanOrEqual(1);
        },
      );

      it.skipIf(!harness.features.countAndExists)(
        'count with filter matches expected rows',
        async () => {
          if (!ctx.repo.count) return;
          const readers = await ctx.repo.count({ category: 'reader' });
          expect(readers).toBe(2);
          const none = await ctx.repo.count({ category: 'no-such' });
          expect(none).toBe(0);
        },
      );

      it.skipIf(!harness.features.countAndExists)(
        'exists is truthy when filter matches, falsy when it does not',
        async () => {
          if (!ctx.repo.exists) return;
          const hit = await ctx.repo.exists({ category: 'reader' });
          const miss = await ctx.repo.exists({ category: 'no-such' });
          // Backends may return boolean or { _id } — both truthy-friendly.
          expect(Boolean(hit)).toBe(true);
          expect(Boolean(miss)).toBe(false);
        },
      );
    });

    // ──────────────────────────────────────────────────────────────────
    // aggregate — portable group-by IR
    // ──────────────────────────────────────────────────────────────────

    describe('aggregate', () => {
      beforeEach(async () => {
        await ctx.repo.createMany!([
          harness.makeDoc({ name: 'a', category: 'reader', count: 10, active: true }),
          harness.makeDoc({ name: 'b', category: 'reader', count: 20, active: true }),
          harness.makeDoc({ name: 'c', category: 'admin', count: 30, active: false }),
          harness.makeDoc({ name: 'd', category: 'admin', count: 40, active: true }),
        ]);
      });

      it.skipIf(skipNoAgg)('empty result set returns { rows: [] } (no throw)', async () => {
        if (!ctx.repo.aggregate) return;
        const result = await ctx.repo.aggregate({
          filter: { category: 'does-not-exist' },
          groupBy: 'category',
          measures: { total: { op: 'sum', field: 'count' } },
        });
        expect(result.rows).toEqual([]);
      });

      it.skipIf(skipNoAgg)(
        'groupBy + sum produces one row per group with correct totals',
        async () => {
          if (!ctx.repo.aggregate) return;
          const result = await ctx.repo.aggregate<{ category: string; total: number }>({
            groupBy: 'category',
            measures: { total: { op: 'sum', field: 'count' } },
            sort: { category: 1 },
          });
          expect(result.rows).toHaveLength(2);
          const byCategory: Record<string, number> = {};
          for (const row of result.rows) {
            byCategory[row.category as string] = Number(row.total);
          }
          expect(byCategory['admin']).toBe(70);
          expect(byCategory['reader']).toBe(30);
        },
      );

      it.skipIf(skipNoAgg)('scalar aggregate (no groupBy) returns single row', async () => {
        if (!ctx.repo.aggregate) return;
        const result = await ctx.repo.aggregate<{ total: number; n: number }>({
          measures: {
            total: { op: 'sum', field: 'count' },
            n: { op: 'count' },
          },
        });
        expect(result.rows).toHaveLength(1);
        expect(Number(result.rows[0]?.total)).toBe(100);
        expect(Number(result.rows[0]?.n)).toBe(4);
      });

      it.skipIf(skipNoAgg)('having filters aggregated rows by measure alias', async () => {
        if (!ctx.repo.aggregate) return;
        const result = await ctx.repo.aggregate<{ category: string; total: number }>({
          groupBy: 'category',
          measures: { total: { op: 'sum', field: 'count' } },
          having: gt('total', 50),
        });
        expect(result.rows).toHaveLength(1);
        expect((result.rows[0] as { category: string }).category).toBe('admin');
      });

      // ── Filtered measures ─────────────────────────────────────────
      // Per-measure `where` predicates scope the aggregate to a subset
      // of rows within each group — equivalent to SQL's
      // `SUM(amount) FILTER (WHERE status = 'paid')`. Same input
      // AggRequest produces the same rows on every kit; cross-kit
      // dashboards stay byte-stable.

      it.skipIf(skipNoAgg)('filtered sum/count: KPI tiles side-by-side', async () => {
        if (!ctx.repo.aggregate) return;
        // Seeded fixture from the parent describe:
        //   a (reader, active, 10), b (reader, active, 20)
        //   c (admin, INACTIVE, 30), d (admin, active, 40)
        const result = await ctx.repo.aggregate<{
          category: string;
          activeCount: number;
          inactiveCount: number;
          activeTotal: number;
          grandTotal: number;
        }>({
          groupBy: 'category',
          measures: {
            activeCount: { op: 'count', where: eq('active', true) },
            inactiveCount: { op: 'count', where: eq('active', false) },
            activeTotal: {
              op: 'sum',
              field: 'count',
              where: eq('active', true),
            },
            grandTotal: { op: 'sum', field: 'count' },
          },
          sort: { category: 1 },
        });
        expect(result.rows).toEqual([
          {
            category: 'admin',
            activeCount: 1,
            inactiveCount: 1,
            activeTotal: 40,
            grandTotal: 70,
          },
          {
            category: 'reader',
            activeCount: 2,
            inactiveCount: 0,
            activeTotal: 30,
            grandTotal: 30,
          },
        ]);
      });

      it.skipIf(skipNoAgg)(
        'filtered avg ignores non-matching rows (no bias toward 0)',
        async () => {
          if (!ctx.repo.aggregate) return;
          // Avg count of admin rows where active=true should be 40
          // (only `d` qualifies) — `c` (inactive, 30) must NOT pull
          // the average down. Naive impls coerce non-matches to 0 and
          // divide, getting 35; the right answer is 40.
          const result = await ctx.repo.aggregate<{ avgActive: number | null }>({
            filter: eq('category', 'admin'),
            measures: {
              avgActive: {
                op: 'avg',
                field: 'count',
                where: eq('active', true),
              },
            },
          });
          expect(Number(result.rows[0]?.avgActive)).toBe(40);
        },
      );

      // ── Top-N-per-group ──────────────────────────────────────────
      // Same input AggRequest produces the same per-partition slice
      // on every kit. Mongokit uses `$setWindowFields`; sqlitekit
      // uses an in-memory post-processor; cross-kit row shape stays
      // byte-identical. Gated on `aggregateOps.topN` so kits without
      // a window-function path can opt out cleanly.

      it.skipIf(skipNoTopN)('top-N: keep top 1 per category by count', async () => {
        if (!ctx.repo.aggregate) return;
        // Parent fixture: a/b in reader (count 10/20), c/d in admin
        // (count 30/40). Top 1 per category by count desc → b + d.
        const result = await ctx.repo.aggregate<{
          category: string;
          name: string;
          n: number;
        }>({
          groupBy: ['category', 'name'],
          measures: { n: { op: 'sum', field: 'count' } },
          topN: {
            partitionBy: 'category',
            sortBy: { n: -1 },
            limit: 1,
          },
          sort: { category: 1 },
        });
        expect(result.rows).toEqual([
          { category: 'admin', name: 'd', n: 40 },
          { category: 'reader', name: 'b', n: 20 },
        ]);
      });

      it.skipIf(skipNoTopN)(
        'top-N: row_number ties strategy yields exactly N rows per partition',
        async () => {
          if (!ctx.repo.aggregate) return;
          const result = await ctx.repo.aggregate<{
            category: string;
            name: string;
          }>({
            groupBy: ['category', 'name'],
            measures: { n: { op: 'count' } },
            topN: {
              partitionBy: 'category',
              sortBy: { name: 1 },
              limit: 1,
              ties: 'row_number',
            },
            sort: { category: 1 },
          });
          // First name alphabetically per category: reader→a, admin→c.
          expect(result.rows.map((r) => `${r.category}:${r.name}`)).toEqual([
            'admin:c',
            'reader:a',
          ]);
        },
      );

      it.skipIf(skipNoTopN)(
        'top-N: throws on partitionBy referencing an unknown column',
        async () => {
          if (!ctx.repo.aggregate) return;
          await expect(
            ctx.repo.aggregate({
              groupBy: 'category',
              measures: { n: { op: 'count' } },
              topN: {
                partitionBy: 'does-not-exist',
                sortBy: { n: -1 },
                limit: 1,
              },
            }),
          ).rejects.toThrow(/topN\.partitionBy "does-not-exist"/);
        },
      );

      // ── Percentile measure ───────────────────────────────────────
      // Asymmetric: mongokit (Mongo 7+) supports it via `$percentile`,
      // sqlitekit throws by design. Gated on `aggregateOps.percentile`.
      // This is the first scenario type where cross-kit IR portability
      // breaks down — pin the kit you target if percentile is a
      // critical dashboard requirement.

      it.skipIf(skipNoPercentile)(
        'percentile: P50 / P95 / P99 over a uniform distribution',
        async () => {
          if (!ctx.repo.aggregate) return;
          // Reset and seed 100 evenly-distributed counts (1..100). P50
          // ≈ 50, P95 ≈ 95, P99 ≈ 99 within the t-digest tolerance.
          for (let i = 1; i <= 100; i++) {
            await ctx.repo.create(harness.makeDoc({ name: `p${i}`, category: 'pct', count: i }));
          }
          const result = await ctx.repo.aggregate<{
            p50: number;
            p95: number;
            p99: number;
          }>({
            filter: eq('category', 'pct'),
            measures: {
              p50: { op: 'percentile', field: 'count', p: 0.5 },
              p95: { op: 'percentile', field: 'count', p: 0.95 },
              p99: { op: 'percentile', field: 'count', p: 0.99 },
            },
          });
          const row = result.rows[0]!;
          expect(Number(row.p50)).toBeGreaterThanOrEqual(48);
          expect(Number(row.p50)).toBeLessThanOrEqual(52);
          expect(Number(row.p95)).toBeGreaterThanOrEqual(93);
          expect(Number(row.p95)).toBeLessThanOrEqual(97);
          expect(Number(row.p99)).toBeGreaterThanOrEqual(97);
          expect(Number(row.p99)).toBeLessThanOrEqual(100);
        },
      );

      it.skipIf(skipNoPercentile)('percentile: rejects p outside [0, 1]', async () => {
        if (!ctx.repo.aggregate) return;
        await expect(
          ctx.repo.aggregate({
            measures: {
              bad: { op: 'percentile', field: 'count', p: 1.5 },
            },
          }),
        ).rejects.toThrow(/percentile/);
      });

      // ── Stddev / stddevPop ───────────────────────────────────────
      // Asymmetric like percentile — mongokit native, sqlitekit
      // throws. Gated on `aggregateOps.stddev`.

      it.skipIf(skipNoStddev)(
        'stddev (sample) matches numpy.std(ddof=1) over [2, 4, 4, 4, 5, 5, 7, 9]',
        async () => {
          if (!ctx.repo.aggregate) return;
          // Wikipedia's classic stddev sample. Result ≈ 2.138.
          for (const value of [2, 4, 4, 4, 5, 5, 7, 9]) {
            await ctx.repo.create(
              harness.makeDoc({ name: `s${value}`, category: 'std', count: value }),
            );
          }
          const result = await ctx.repo.aggregate<{ s: number }>({
            filter: eq('category', 'std'),
            measures: { s: { op: 'stddev', field: 'count' } },
          });
          expect(Number(result.rows[0]?.s)).toBeCloseTo(2.138, 2);
        },
      );

      it.skipIf(skipNoStddev)(
        'stddevPop (population) matches numpy.std(ddof=0) over the same set',
        async () => {
          if (!ctx.repo.aggregate) return;
          for (const value of [2, 4, 4, 4, 5, 5, 7, 9]) {
            await ctx.repo.create(
              harness.makeDoc({ name: `p${value}`, category: 'pop', count: value }),
            );
          }
          const result = await ctx.repo.aggregate<{ s: number }>({
            filter: eq('category', 'pop'),
            measures: { s: { op: 'stddevPop', field: 'count' } },
          });
          expect(Number(result.rows[0]?.s)).toBeCloseTo(2.0, 6);
        },
      );

      // ── Per-request cache ────────────────────────────────────────
      // Uses `ctx.cachedRepo` (separate from `ctx.repo`) so cache
      // state is hermetic to this scenario. Harness wires the adapter;
      // scenarios just exercise the API contract.

      it.skipIf(skipNoCache)(
        'cache hit: same call within staleTime returns cached value (no DB re-read)',
        async () => {
          const cachedRepo = ctx.cachedRepo;
          if (!cachedRepo || !cachedRepo.aggregate) return;
          await cachedRepo.create(harness.makeDoc({ name: 'c1', category: 'cache', count: 100 }));

          const first = await cachedRepo.aggregate<{ sum: number }>({
            filter: eq('category', 'cache'),
            measures: { sum: { op: 'sum', field: 'count' } },
            cache: { staleTime: 60 },
          });
          expect(Number(first.rows[0]?.sum)).toBe(100);

          // Repeat the same call — cached value served, no DB hit.
          // (Verified by spying isn't portable across kits, so we
          //  rely on identical-result assertion under freshness window.)
          const second = await cachedRepo.aggregate<{ sum: number }>({
            filter: eq('category', 'cache'),
            measures: { sum: { op: 'sum', field: 'count' } },
            cache: { staleTime: 60 },
          });
          expect(Number(second.rows[0]?.sum)).toBe(100);
        },
      );

      it.skipIf(skipNoCache)(
        'write invalidates the cache: subsequent read sees the fresh result',
        async () => {
          const cachedRepo = ctx.cachedRepo;
          if (!cachedRepo || !cachedRepo.aggregate) return;
          await cachedRepo.create(harness.makeDoc({ name: 'wi1', category: 'wi', count: 100 }));
          const first = await cachedRepo.aggregate<{ sum: number }>({
            filter: eq('category', 'wi'),
            measures: { sum: { op: 'sum', field: 'count' } },
            cache: { staleTime: 60 },
          });
          expect(Number(first.rows[0]?.sum)).toBe(100);

          // Write through the repo — cache plugin's `after:create` hook
          // bumps the model version, orphaning the cached aggregate.
          await cachedRepo.create(harness.makeDoc({ name: 'wi2', category: 'wi', count: 999 }));
          const second = await cachedRepo.aggregate<{ sum: number }>({
            filter: eq('category', 'wi'),
            measures: { sum: { op: 'sum', field: 'count' } },
            cache: { staleTime: 60 },
          });
          // Auto-invalidation: write between calls busts the cache.
          expect(Number(second.rows[0]?.sum)).toBe(1099);
        },
      );

      it.skipIf(skipNoCache)('bypass: forces fresh fetch + overwrites cached entry', async () => {
        const cachedRepo = ctx.cachedRepo;
        if (!cachedRepo || !cachedRepo.aggregate) return;
        await cachedRepo.create(harness.makeDoc({ name: 'b1', category: 'bp', count: 50 }));
        await cachedRepo.aggregate({
          filter: eq('category', 'bp'),
          measures: { sum: { op: 'sum', field: 'count' } },
          cache: { staleTime: 60 },
        });
        await cachedRepo.create(harness.makeDoc({ name: 'b2', category: 'bp', count: 100 }));
        const fresh = await cachedRepo.aggregate<{ sum: number }>({
          filter: eq('category', 'bp'),
          measures: { sum: { op: 'sum', field: 'count' } },
          cache: { staleTime: 60, bypass: true },
        });
        expect(Number(fresh.rows[0]?.sum)).toBe(150);
      });

      it.skipIf(skipNoCache)(
        'tag invalidation via repo.cache.invalidateByTags clears matching entries',
        async () => {
          const cachedRepo = ctx.cachedRepo;
          if (!cachedRepo || !cachedRepo.aggregate) return;
          await cachedRepo.create(harness.makeDoc({ name: 'i1', category: 'inv', count: 10 }));
          await cachedRepo.aggregate({
            filter: eq('category', 'inv'),
            measures: { sum: { op: 'sum', field: 'count' } },
            cache: { staleTime: 60, tags: ['inv-tag'] },
          });

          // Plugin attaches `repo.cache` handle exposing invalidateByTags.
          const handle = (
            cachedRepo as unknown as {
              cache?: { invalidateByTags(tags: readonly string[]): Promise<number> };
            }
          ).cache;
          if (!handle) return; // older kit without the unified plugin
          const cleared = await handle.invalidateByTags(['inv-tag']);
          expect(cleared).toBeGreaterThanOrEqual(1);
        },
      );
    });

    // ──────────────────────────────────────────────────────────────────
    // aggregate — date buckets + keyset pagination
    //
    // Lives in its own describe with its own seed because the cross-kit
    // assertions need varied `createdAt` values (the parent seed leaves
    // createdAt at the harness default — fine for groupBy by category,
    // useless for bucketing). New docs use categories the parent doesn't
    // — so the seeds coexist without needing a deleteMany cleanup that
    // some kits refuse on an empty filter.
    // ──────────────────────────────────────────────────────────────────

    describe('aggregate — date buckets + keyset', () => {
      // Bucket-test categories. Distinct from the parent describe's
      // `'reader'` / `'admin'` so we can filter to JUST these rows.
      const BUCKET_CATS = ['bk-paid', 'bk-pending'] as const;

      // Keyset-test categories. Five values so the tests can walk
      // multiple pages.
      const KEYSET_CATS = ['ks-a', 'ks-b', 'ks-c', 'ks-d', 'ks-e'] as const;

      beforeEach(async () => {
        // Bucket fixture: 5 paid docs spread across Jan/Feb/Apr/Jul +
        // 1 pending in Feb. Identical timestamps + counts cross-kit.
        await ctx.repo.createMany!([
          harness.makeDoc({
            name: 'bk1',
            category: 'bk-paid',
            count: 100,
            createdAt: '2026-01-15T10:00:00Z',
          }),
          harness.makeDoc({
            name: 'bk2',
            category: 'bk-paid',
            count: 200,
            createdAt: '2026-01-22T10:00:00Z',
          }),
          harness.makeDoc({
            name: 'bk3',
            category: 'bk-paid',
            count: 300,
            createdAt: '2026-02-05T10:00:00Z',
          }),
          harness.makeDoc({
            name: 'bk4',
            category: 'bk-pending',
            count: 50,
            createdAt: '2026-02-05T10:00:00Z',
          }),
          harness.makeDoc({
            name: 'bk5',
            category: 'bk-paid',
            count: 400,
            createdAt: '2026-04-10T10:00:00Z',
          }),
          harness.makeDoc({
            name: 'bk6',
            category: 'bk-paid',
            count: 500,
            createdAt: '2026-07-20T10:00:00Z',
          }),
        ]);
        // Keyset fixture: 5 distinct categories, one doc each. Counts
        // are 10/11/30/40/50 so sum-by-category sort is well-defined.
        for (let i = 0; i < KEYSET_CATS.length; i++) {
          const cat = KEYSET_CATS[i] as string;
          await ctx.repo.create(harness.makeDoc({ name: cat, category: cat, count: 10 + i * 10 }));
        }
      });

      // ── Date buckets ─────────────────────────────────────────────
      // Same AggRequest → same bucketed rows on every kit. Bucket
      // labels are canonical ISO-shaped: `YYYY-MM` / `YYYY-MM-DD` /
      // `YYYY-Qn` / `YYYY` — byte-stable across backends so dashboards
      // render identically.

      it.skipIf(skipNoAgg)('date bucket month groups rows under YYYY-MM labels', async () => {
        if (!ctx.repo.aggregate) return;
        const result = await ctx.repo.aggregate<{ month: string; revenue: number }>({
          filter: { category: 'bk-paid' },
          dateBuckets: { month: { field: 'createdAt', interval: 'month' } },
          measures: { revenue: { op: 'sum', field: 'count' } },
          sort: { month: 1 },
        });
        expect(result.rows).toEqual([
          { month: '2026-01', revenue: 300 },
          { month: '2026-02', revenue: 300 },
          { month: '2026-04', revenue: 400 },
          { month: '2026-07', revenue: 500 },
        ]);
      });

      it.skipIf(skipNoAgg)('date bucket day emits YYYY-MM-DD', async () => {
        if (!ctx.repo.aggregate) return;
        const result = await ctx.repo.aggregate<{ day: string; n: number }>({
          filter: { category: 'bk-paid' },
          dateBuckets: { day: { field: 'createdAt', interval: 'day' } },
          measures: { n: { op: 'count' } },
          sort: { day: 1 },
        });
        expect(result.rows.map((r) => (r as { day: string }).day)).toEqual([
          '2026-01-15',
          '2026-01-22',
          '2026-02-05',
          '2026-04-10',
          '2026-07-20',
        ]);
      });

      it.skipIf(skipNoAgg)('date bucket quarter emits YYYY-Qn', async () => {
        if (!ctx.repo.aggregate) return;
        const result = await ctx.repo.aggregate<{ q: string; n: number }>({
          filter: { category: 'bk-paid' },
          dateBuckets: { q: { field: 'createdAt', interval: 'quarter' } },
          measures: { n: { op: 'count' } },
          sort: { q: 1 },
        });
        // Q1: Jan/Feb (3 docs); Q2: Apr (1 doc); Q3: Jul (1 doc).
        expect(result.rows).toEqual([
          { q: '2026-Q1', n: 3 },
          { q: '2026-Q2', n: 1 },
          { q: '2026-Q3', n: 1 },
        ]);
      });

      it.skipIf(skipNoAgg)('date bucket year emits YYYY', async () => {
        if (!ctx.repo.aggregate) return;
        const result = await ctx.repo.aggregate<{ year: string; n: number }>({
          filter: { category: 'bk-paid' },
          dateBuckets: { year: { field: 'createdAt', interval: 'year' } },
          measures: { n: { op: 'count' } },
        });
        expect(result.rows).toEqual([{ year: '2026', n: 5 }]);
      });

      // ── Custom-bin intervals ────────────────────────────────────
      // `{ every: N, unit }` form for arbitrary intervals like
      // 15-minute or 6-hour bins. Both kits emit identical labels
      // for the same input so cross-kit dashboards stay byte-stable.

      it.skipIf(skipNoCustomBuckets)('custom 15-minute bins', async () => {
        if (!ctx.repo.aggregate) return;
        // Seed 5 docs in JAN where we control timestamps tightly.
        // Categories tagged `bk2-*` so they don't collide with
        // existing bucket fixtures from the parent beforeEach.
        await ctx.repo.createMany!([
          harness.makeDoc({
            name: 'q1',
            category: 'bk2',
            count: 1,
            createdAt: '2026-04-15T10:00:00Z',
          }),
          harness.makeDoc({
            name: 'q2',
            category: 'bk2',
            count: 1,
            createdAt: '2026-04-15T10:14:00Z',
          }),
          harness.makeDoc({
            name: 'q3',
            category: 'bk2',
            count: 1,
            createdAt: '2026-04-15T10:15:00Z',
          }),
          harness.makeDoc({
            name: 'q4',
            category: 'bk2',
            count: 1,
            createdAt: '2026-04-15T10:29:00Z',
          }),
          harness.makeDoc({
            name: 'q5',
            category: 'bk2',
            count: 1,
            createdAt: '2026-04-15T10:30:00Z',
          }),
        ]);
        const result = await ctx.repo.aggregate<{ bin: string; n: number }>({
          filter: eq('category', 'bk2'),
          dateBuckets: {
            bin: { field: 'createdAt', interval: { every: 15, unit: 'minute' } },
          },
          measures: { n: { op: 'count' } },
          sort: { bin: 1 },
        });
        expect(result.rows).toEqual([
          { bin: '2026-04-15T10:00', n: 2 },
          { bin: '2026-04-15T10:15', n: 2 },
          { bin: '2026-04-15T10:30', n: 1 },
        ]);
      });

      it.skipIf(skipNoSubMinuteBuckets)('named hour bucket emits YYYY-MM-DDTHH:00', async () => {
        if (!ctx.repo.aggregate) return;
        await ctx.repo.createMany!([
          harness.makeDoc({
            name: 'h1',
            category: 'bk3',
            count: 1,
            createdAt: '2026-04-15T10:15:00Z',
          }),
          harness.makeDoc({
            name: 'h2',
            category: 'bk3',
            count: 1,
            createdAt: '2026-04-15T10:45:00Z',
          }),
          harness.makeDoc({
            name: 'h3',
            category: 'bk3',
            count: 1,
            createdAt: '2026-04-15T11:05:00Z',
          }),
        ]);
        const result = await ctx.repo.aggregate<{ hour: string; n: number }>({
          filter: eq('category', 'bk3'),
          dateBuckets: { hour: { field: 'createdAt', interval: 'hour' } },
          measures: { n: { op: 'count' } },
          sort: { hour: 1 },
        });
        expect(result.rows).toEqual([
          { hour: '2026-04-15T10:00', n: 2 },
          { hour: '2026-04-15T11:00', n: 1 },
        ]);
      });

      it.skipIf(skipNoAgg)('date bucket combines with groupBy column', async () => {
        if (!ctx.repo.aggregate) return;
        const result = await ctx.repo.aggregate<{
          month: string;
          category: string;
          n: number;
        }>({
          filter: in_('category', [...BUCKET_CATS]),
          dateBuckets: { month: { field: 'createdAt', interval: 'month' } },
          groupBy: 'category',
          measures: { n: { op: 'count' } },
          sort: { month: 1, category: 1 },
        });
        expect(result.rows).toEqual([
          { month: '2026-01', category: 'bk-paid', n: 2 },
          { month: '2026-02', category: 'bk-paid', n: 1 },
          { month: '2026-02', category: 'bk-pending', n: 1 },
          { month: '2026-04', category: 'bk-paid', n: 1 },
          { month: '2026-07', category: 'bk-paid', n: 1 },
        ]);
      });

      // ── Keyset pagination ────────────────────────────────────────
      // Cursor format is opaque + kit-specific (cross-kit byte
      // stability NOT promised), but the page-walking contract is
      // universal: chaining `next` → `after` walks the full result
      // set with no overlaps and no gaps.

      it.skipIf(skipNoAgg)('aggregatePaginate keyset walks all groups via cursor', async () => {
        if (!ctx.repo.aggregatePaginate) return;
        type Row = { category: string; n: number };
        type PaginateResult = OffsetPaginationResult<Row> | KeysetAggPaginationResult<Row>;
        const seen: string[] = [];
        let cursor: string | null = null;
        // Bind through a non-optional alias so TS sees a concrete
        // signature (the contract types `aggregatePaginate?` as
        // optional, which loses the union return when read inline).
        // `.bind(repo)` preserves `this` — kits implement the method
        // on their Repository class and rely on `this._buildContext`.
        const aggregatePaginate = ctx.repo.aggregatePaginate.bind(ctx.repo) as NonNullable<
          typeof ctx.repo.aggregatePaginate
        >;

        for (let i = 0; i < 10; i++) {
          const result: PaginateResult = await aggregatePaginate<Row>({
            filter: in_('category', [...KEYSET_CATS]),
            groupBy: 'category',
            measures: { n: { op: 'count' } },
            sort: { category: 1 },
            pagination: 'keyset',
            limit: 2,
            ...(cursor ? { after: cursor } : {}),
          });
          expect(result.method).toBe('keyset');
          if (result.method !== 'keyset') throw new Error('expected keyset envelope');
          for (const row of result.data) seen.push(row.category);
          cursor = result.next;
          if (!result.hasMore) break;
        }
        expect(seen).toEqual([...KEYSET_CATS]);
      });

      it.skipIf(skipNoAgg)(
        'aggregatePaginate keyset hasMore is false on the final page',
        async () => {
          if (!ctx.repo.aggregatePaginate) return;
          type Row = { category: string; n: number };
          // Bind through a non-optional alias so TS sees a concrete
          // signature (the contract types `aggregatePaginate?` as
          // optional, which loses the union return when read inline).
          // `.bind(repo)` preserves `this` — kits implement the method
          // on their Repository class and rely on `this._buildContext`.
          const aggregatePaginate = ctx.repo.aggregatePaginate.bind(ctx.repo) as NonNullable<
            typeof ctx.repo.aggregatePaginate
          >;

          type PaginateResult = OffsetPaginationResult<Row> | KeysetAggPaginationResult<Row>;
          const result: PaginateResult = await aggregatePaginate<Row>({
            filter: in_('category', [...KEYSET_CATS]),
            groupBy: 'category',
            measures: { n: { op: 'count' } },
            sort: { category: 1 },
            pagination: 'keyset',
            limit: 100, // larger than result set
          });
          expect(result.method).toBe('keyset');
          if (result.method !== 'keyset') throw new Error('expected keyset envelope');
          expect(result.data).toHaveLength(KEYSET_CATS.length);
          expect(result.hasMore).toBe(false);
          expect(result.next).toBeNull();
        },
      );
    });

    // ──────────────────────────────────────────────────────────────────
    // Pagination edges
    // ──────────────────────────────────────────────────────────────────

    describe('pagination edges', () => {
      beforeEach(async () => {
        for (let i = 0; i < 5; i++) {
          await ctx.repo.create(harness.makeDoc({ name: `p${i}`, count: i, createdAt: isoAt(i) }));
        }
      });

      it('page beyond last returns empty docs array, total reflects real count', async () => {
        const out = (await ctx.repo.getAll({
          page: 99,
          limit: 10,
          sort: 'createdAt',
        })) as { data?: unknown[]; total?: number };
        // Offset envelope — every kit returns { data, total, ... }
        expect(Array.isArray(out.data)).toBe(true);
        expect(out.data).toHaveLength(0);
        expect(out.total).toBe(5);
      });

      it('limit larger than dataset returns all rows, no error', async () => {
        const out = (await ctx.repo.getAll({
          page: 1,
          limit: 1000,
          sort: 'createdAt',
        })) as { data: unknown[]; total: number };
        expect(out.data).toHaveLength(5);
        expect(out.total).toBe(5);
      });

      it('explicit filter in pagination narrows results consistently', async () => {
        const out = (await ctx.repo.getAll({
          filters: { count: 3 } as Partial<TDoc> & Record<string, unknown>,
          page: 1,
          limit: 10,
        })) as { data: unknown[]; total: number };
        expect(out.data).toHaveLength(1);
        expect(out.total).toBe(1);
      });
    });

    // ──────────────────────────────────────────────────────────────────
    // Filter IR corner cases
    // ──────────────────────────────────────────────────────────────────

    describe('Filter IR compilation parity', () => {
      beforeEach(async () => {
        await ctx.repo.createMany!([
          harness.makeDoc({ name: 'plain', category: 'a', count: 1, notes: 'hello world' }),
          harness.makeDoc({ name: 'pct', category: 'a', count: 2, notes: '50% off' }),
          harness.makeDoc({ name: 'under', category: 'b', count: 3, notes: 'file_name.txt' }),
          harness.makeDoc({ name: 'back', category: 'b', count: 4, notes: 'back\\slash' }),
          harness.makeDoc({ name: 'nullnote', category: null, count: 5, notes: null }),
        ]);
      });

      it('in_([]) matches nothing (not everything)', async () => {
        const rows = await ctx.repo.findAll!(in_('category', []));
        expect(rows).toHaveLength(0);
      });

      it('in_ with non-empty list matches those values', async () => {
        const rows = await ctx.repo.findAll!(in_('category', ['a']));
        expect(rows).toHaveLength(2);
      });

      it('eq null matches rows where the field is null', async () => {
        const rows = await ctx.repo.findAll!(isNull('category'));
        expect(rows).toHaveLength(1);
        expect(rows[0]?.name).toBe('nullnote');
      });

      it('ne does not include null-valued rows (SQL 3VL / Mongo parity)', async () => {
        // Both SQL (3-valued logic) and Mongo exclude null rows from
        // `field != 'a'` — the parity is what matters here.
        const rows = await ctx.repo.findAll!(ne('category', 'a'));
        const names = rows.map((r) => r.name).sort();
        // 'nullnote' row has category=null — excluded by ne semantics.
        expect(names).toEqual(['back', 'under']);
      });

      it('like with % metacharacter in the value matches literally', async () => {
        // '50% off' should match '50\\% off' with a literal percent.
        // Delegates escape responsibility to the compiler — if either
        // backend fails to escape, all rows come back (false positive).
        const rows = await ctx.repo.findAll!(like('notes', '50\\% off'));
        expect(rows.map((r) => r.name)).toEqual(['pct']);
      });

      it('like with _ metacharacter in the value matches literally', async () => {
        const rows = await ctx.repo.findAll!(like('notes', 'file\\_name.txt'));
        expect(rows.map((r) => r.name)).toEqual(['under']);
      });

      it('nested and/or composes correctly', async () => {
        // (category = a AND count > 1) OR name = 'back'
        const rows = await ctx.repo.findAll!(
          or(and(eq('category', 'a'), gt('count', 1)), eq('name', 'back')),
        );
        const names = rows.map((r) => r.name).sort();
        expect(names).toEqual(['back', 'pct']);
      });
    });

    // ──────────────────────────────────────────────────────────────────
    // isDuplicateKeyError classification
    // ──────────────────────────────────────────────────────────────────

    describe.skipIf(!harness.features.duplicateKeyError)('isDuplicateKeyError', () => {
      it('returns true for a unique-constraint / E11000 violation', async () => {
        await ctx.repo.create(harness.makeDoc({ name: 'dup', email: 'dup@x.com' }));
        let caught: unknown;
        try {
          await ctx.repo.create(harness.makeDoc({ name: 'dup2', email: 'dup@x.com' }));
        } catch (err) {
          caught = err;
        }
        expect(caught).toBeDefined();
        expect(ctx.repo.isDuplicateKeyError?.(caught)).toBe(true);
      });

      it('returns false for unrelated errors', async () => {
        const notDup = new Error('something else');
        expect(ctx.repo.isDuplicateKeyError?.(notDup)).toBe(false);
        expect(ctx.repo.isDuplicateKeyError?.(null)).toBe(false);
        expect(ctx.repo.isDuplicateKeyError?.('plain string')).toBe(false);
      });
    });

    // ──────────────────────────────────────────────────────────────────
    // getOrCreate
    // ──────────────────────────────────────────────────────────────────

    describe.skipIf(!harness.features.getOrCreate)('getOrCreate', () => {
      it('inserts when no row matches filter (created: true)', async () => {
        if (!ctx.repo.getOrCreate) return;
        const result = await ctx.repo.getOrCreate(
          { email: 'fresh@x.com' },
          harness.makeDoc({ name: 'Fresh', email: 'fresh@x.com' }),
        );
        expect((result.doc as { name: string }).name).toBe('Fresh');
        expect(result.created).toBe(true);
        const all = await ctx.repo.findAll!();
        expect(all).toHaveLength(1);
      });

      it('returns existing row when filter matches (created: false, no insert)', async () => {
        if (!ctx.repo.getOrCreate) return;
        await ctx.repo.create(harness.makeDoc({ name: 'Existing', email: 'existing@x.com' }));
        const result = await ctx.repo.getOrCreate(
          { email: 'existing@x.com' },
          harness.makeDoc({ name: 'WouldOverwrite', email: 'existing@x.com' }),
        );
        expect((result.doc as { name: string }).name).toBe('Existing');
        expect(result.created).toBe(false);
        const all = await ctx.repo.findAll!();
        expect(all).toHaveLength(1);
      });
    });

    // ──────────────────────────────────────────────────────────────────
    // withTransaction — commit + rollback
    // ──────────────────────────────────────────────────────────────────

    describe.skipIf(!harness.features.transactions)('withTransaction', () => {
      it('commits when callback resolves', async () => {
        await ctx.repo.withTransaction!(async (txRepo) => {
          await txRepo.create(harness.makeDoc({ name: 'tx-committed', email: 'c@x.com' }));
        });
        const rows = await ctx.repo.findAll!({ name: 'tx-committed' });
        expect(rows).toHaveLength(1);
      });

      it('rolls back on thrown error — no row persists', async () => {
        const err = new Error('boom');
        let caught: unknown;
        try {
          await ctx.repo.withTransaction!(async (txRepo) => {
            await txRepo.create(harness.makeDoc({ name: 'tx-rollback', email: 'r@x.com' }));
            throw err;
          });
        } catch (e) {
          caught = e;
        }
        expect(caught).toBe(err);
        const rows = await ctx.repo.findAll!({ name: 'tx-rollback' });
        expect(rows).toHaveLength(0);
      });

      it('reads inside the txRepo see writes inside the same callback', async () => {
        await ctx.repo.withTransaction!(async (txRepo) => {
          const created = await txRepo.create(
            harness.makeDoc({ name: 'tx-read', email: 'rr@x.com' }),
          );
          const id = idOf(created, harness.idField)!;
          const back = await txRepo.getById(id);
          expect(back?.name).toBe('tx-read');
        });
      });
    });

    // ────────────────────────────────────────────────────────────────
    // Tenant purge — compliance-grade cleanup primitive
    // ────────────────────────────────────────────────────────────────
    //
    // Scenarios use the `category` field as a tenant-id proxy — it's
    // declared on ConformanceDoc and every kit's schema accepts it.
    // The `soft` strategy is deliberately NOT exercised here: it requires
    // writable `deleted` / `deletedAt` fields that aren't part of the
    // shared doc shape. Each kit covers `soft` in its own integration
    // tests against its actual schema.
    describe('purgeByField (tenant cleanup)', () => {
      const seedTwoTenants = async () => {
        await ctx.repo.create(harness.makeDoc({ name: 'a-1', category: 'org-a' }));
        await ctx.repo.create(harness.makeDoc({ name: 'a-2', category: 'org-a' }));
        await ctx.repo.create(harness.makeDoc({ name: 'a-3', category: 'org-a' }));
        await ctx.repo.create(harness.makeDoc({ name: 'b-1', category: 'org-b' }));
        await ctx.repo.create(harness.makeDoc({ name: 'b-2', category: 'org-b' }));
      };

      it.skipIf(skipNoPurge)('hard: removes every matching row, leaves others intact', async () => {
        await seedTwoTenants();

        const result = await ctx.repo.purgeByField!('category', 'org-a', { type: 'hard' });

        expect(result.ok).toBe(true);
        expect(result.strategy).toBe('hard');
        expect(result.processed).toBe(3);
        expect(typeof result.durationMs).toBe('number');

        expect(await ctx.repo.count!({ category: 'org-a' })).toBe(0);
        expect(await ctx.repo.count!({ category: 'org-b' })).toBe(2);
      });

      it.skipIf(skipNoPurge)('hard: empty match completes ok with processed: 0', async () => {
        const result = await ctx.repo.purgeByField!('category', 'nonexistent', { type: 'hard' });
        expect(result.ok).toBe(true);
        expect(result.processed).toBe(0);
      });

      it.skipIf(skipNoPurge)('anonymize: overwrites declared fields, keeps the row', async () => {
        await seedTwoTenants();

        const result = await ctx.repo.purgeByField!('category', 'org-a', {
          type: 'anonymize',
          fields: { name: '[REDACTED]', notes: null },
        });

        expect(result.ok).toBe(true);
        expect(result.strategy).toBe('anonymize');
        expect(result.processed).toBe(3);

        // Rows still exist (count by category unchanged) but PII fields cleared.
        expect(await ctx.repo.count!({ category: 'org-a' })).toBe(3);
        const redacted = await ctx.repo.findAll!({ category: 'org-a' });
        for (const row of redacted) {
          expect(row.name).toBe('[REDACTED]');
          expect(row.notes).toBeNull();
        }

        // Other tenant untouched.
        const others = await ctx.repo.findAll!({ category: 'org-b' });
        for (const row of others) {
          expect(row.name).not.toBe('[REDACTED]');
        }
      });

      it.skipIf(skipNoPurge)('skip: no-op, returns reason and processed: 0', async () => {
        await seedTwoTenants();

        const result = await ctx.repo.purgeByField!('category', 'org-a', {
          type: 'skip',
          reason: 'audit-retained-per-SOX',
        });

        expect(result.ok).toBe(true);
        expect(result.strategy).toBe('skip');
        expect(result.processed).toBe(0);
        expect(result.skipReason).toBe('audit-retained-per-SOX');

        // Nothing changed.
        expect(await ctx.repo.count!({ category: 'org-a' })).toBe(3);
        expect(await ctx.repo.count!({ category: 'org-b' })).toBe(2);
      });

      it.skipIf(skipNoPurge)(
        'chunking: batchSize honored, onProgress fires per chunk',
        async () => {
          // Seed 25 rows for org-a so a batchSize of 10 yields 3 chunks (10 + 10 + 5).
          for (let i = 0; i < 25; i++) {
            await ctx.repo.create(harness.makeDoc({ name: `chunk-${i}`, category: 'org-chunk' }));
          }

          const progressEvents: Array<{ processed: number; chunkSize: number }> = [];
          const result = await ctx.repo.purgeByField!(
            'category',
            'org-chunk',
            { type: 'hard' },
            {
              batchSize: 10,
              onProgress: (event) => {
                progressEvents.push({ processed: event.processed, chunkSize: event.chunkSize });
              },
            },
          );

          expect(result.processed).toBe(25);
          expect(progressEvents.length).toBe(3);
          expect(progressEvents[0]).toEqual({ processed: 10, chunkSize: 10 });
          expect(progressEvents[1]).toEqual({ processed: 20, chunkSize: 10 });
          expect(progressEvents[2]).toEqual({ processed: 25, chunkSize: 5 });
          expect(await ctx.repo.count!({ category: 'org-chunk' })).toBe(0);
        },
      );

      it.skipIf(skipNoPurge)('idempotent: re-running on the same tenant is a no-op', async () => {
        await seedTwoTenants();

        const first = await ctx.repo.purgeByField!('category', 'org-a', { type: 'hard' });
        expect(first.processed).toBe(3);

        const second = await ctx.repo.purgeByField!('category', 'org-a', { type: 'hard' });
        expect(second.ok).toBe(true);
        expect(second.processed).toBe(0);
      });

      it.skipIf(skipNoPurge)('scoping: only rows matching field=value are affected', async () => {
        // Cross-tenant safety check — the most important invariant.
        await seedTwoTenants();
        const totalBefore = await ctx.repo.count!({});

        await ctx.repo.purgeByField!('category', 'org-a', { type: 'hard' });

        const totalAfter = await ctx.repo.count!({});
        expect(totalAfter).toBe(totalBefore - 3);
        expect(await ctx.repo.count!({ category: 'org-b' })).toBe(2);
      });

      it.skipIf(skipNoPurge)(
        'abort signal: stops between chunks, returns partial count',
        async () => {
          for (let i = 0; i < 25; i++) {
            await ctx.repo.create(harness.makeDoc({ name: `abort-${i}`, category: 'org-abort' }));
          }

          const controller = new AbortController();
          const result = await ctx.repo.purgeByField!(
            'category',
            'org-abort',
            { type: 'hard' },
            {
              batchSize: 10,
              signal: controller.signal,
              onProgress: (event) => {
                // Abort after the first chunk lands.
                if (event.processed === 10) controller.abort();
              },
            },
          );

          // Aborted runs report ok: false; the chunks that did commit stay committed.
          expect(result.ok).toBe(false);
          expect(result.processed).toBe(10);
          const remaining = await ctx.repo.count!({ category: 'org-abort' });
          expect(remaining).toBe(15);
        },
      );

      it.skipIf(skipNoPurge)(
        'retry policy is plumbed through (default no retry, opt-in works)',
        async () => {
          // Smoke test for the retry surface: pass a never-firing
          // `shouldRetry` (defaults to retry-all) with maxAttempts=1 to
          // verify the option is at least accepted by the orchestrator.
          // The actual retry behavior — exponential backoff, transient
          // detection — gets per-kit coverage in unit tests where the
          // driver can be made to fail deterministically.
          await seedTwoTenants();
          const result = await ctx.repo.purgeByField!(
            'category',
            'org-a',
            { type: 'hard' },
            {
              retry: { maxAttempts: 1, baseDelayMs: 10 },
            },
          );
          expect(result.ok).toBe(true);
          expect(result.processed).toBe(3);
        },
      );
    });
  });
}
