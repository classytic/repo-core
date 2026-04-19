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

      it('delete by id succeeds; second delete returns success:false', async () => {
        const created = await ctx.repo.create(harness.makeDoc({ name: 'Carol' }));
        const id = idOf(created, harness.idField)!;

        const first = await ctx.repo.delete(id);
        expect(first.success).toBe(true);

        const second = await ctx.repo.delete(id);
        expect(second.success).toBe(false);
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

      it.skipIf(!harness.features.aggregate)(
        'empty result set returns { rows: [] } (no throw)',
        async () => {
          if (!ctx.repo.aggregate) return;
          const result = await ctx.repo.aggregate({
            filter: { category: 'does-not-exist' },
            groupBy: 'category',
            measures: { total: { op: 'sum', field: 'count' } },
          });
          expect(result.rows).toEqual([]);
        },
      );

      it.skipIf(!harness.features.aggregate)(
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

      it.skipIf(!harness.features.aggregate)(
        'scalar aggregate (no groupBy) returns single row',
        async () => {
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
        },
      );

      it.skipIf(!harness.features.aggregate)(
        'having filters aggregated rows by measure alias',
        async () => {
          if (!ctx.repo.aggregate) return;
          const result = await ctx.repo.aggregate<{ category: string; total: number }>({
            groupBy: 'category',
            measures: { total: { op: 'sum', field: 'count' } },
            having: gt('total', 50),
          });
          expect(result.rows).toHaveLength(1);
          expect((result.rows[0] as { category: string }).category).toBe('admin');
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
        })) as { docs?: unknown[]; total?: number };
        // Offset envelope — every kit returns { docs, total, ... }
        expect(Array.isArray(out.docs)).toBe(true);
        expect(out.docs).toHaveLength(0);
        expect(out.total).toBe(5);
      });

      it('limit larger than dataset returns all rows, no error', async () => {
        const out = (await ctx.repo.getAll({
          page: 1,
          limit: 1000,
          sort: 'createdAt',
        })) as { docs: unknown[]; total: number };
        expect(out.docs).toHaveLength(5);
        expect(out.total).toBe(5);
      });

      it('explicit filter in pagination narrows results consistently', async () => {
        const out = (await ctx.repo.getAll({
          filters: { count: 3 } as Partial<TDoc> & Record<string, unknown>,
          page: 1,
          limit: 10,
        })) as { docs: unknown[]; total: number };
        expect(out.docs).toHaveLength(1);
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
      it('inserts when no row matches filter', async () => {
        if (!ctx.repo.getOrCreate) return;
        const result = await ctx.repo.getOrCreate(
          { email: 'fresh@x.com' },
          harness.makeDoc({ name: 'Fresh', email: 'fresh@x.com' }),
        );
        expect(result?.name).toBe('Fresh');
        const all = await ctx.repo.findAll!();
        expect(all).toHaveLength(1);
      });

      it('returns existing row when filter matches (no insert)', async () => {
        if (!ctx.repo.getOrCreate) return;
        await ctx.repo.create(harness.makeDoc({ name: 'Existing', email: 'existing@x.com' }));
        const result = await ctx.repo.getOrCreate(
          { email: 'existing@x.com' },
          harness.makeDoc({ name: 'WouldOverwrite', email: 'existing@x.com' }),
        );
        expect(result?.name).toBe('Existing');
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
  });
}
