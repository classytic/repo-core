/**
 * Data-access conformance: behaviour groups a kit OPTS INTO through `RepoCapabilities`.
 *
 * Each group runs only when its capability is declared. An undeclared one is reported as a
 * skipped group whose title names the missing capability (never a silent pass), and a declared
 * capability without its fixture fails, because an unproven declaration is decoration (FL4).
 * Groups: `getByIdsOrdered`, `scopedJoins`, `bulkUpsert`, `readModel`.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { BulkUpsertOptions, BulkUpsertResult } from '../repository/bulk-upsert.js';
import type { RepoCapabilities } from '../repository/capabilities.js';
import type { AggRequest, AggResult } from '../repository/types.js';

/** `getByIds(..., { preserveOrder: true })` reached through the kit's own signature. */
export interface OrderedIdsFixture {
  /** Insert one record per name; returns their ids in the same order. */
  insert(names: readonly string[]): Promise<string[]>;
  getOrdered(
    ids: readonly string[],
    options: { chunkSize?: number },
  ): Promise<ReadonlyArray<{ name: string } | undefined>>;
  /** A well-formed id that matches no record. */
  missingId: string;
  cleanup(): Promise<void>;
}

/** A tenant-scoped base and a tenant-scoped, soft-deletable sibling it can join. */
export interface ScopedJoinFixture {
  /** The base repository's portable aggregate. Base rows carry `key`. */
  aggregate(req: AggRequest, scope: Record<string, unknown>): Promise<AggResult>;
  /** Name `lookups[].from` takes for the joined sibling. */
  joined: string;
  seedBase(tenant: string, keys: readonly string[]): Promise<void>;
  /** Joined rows carry `key` and `qty`; `deleted` rows are soft-deleted. */
  seedJoined(
    tenant: string,
    rows: ReadonlyArray<{ key: string; qty: number; deleted?: boolean }>,
  ): Promise<void>;
  /** Call options that scope a read to `tenant`. */
  scope(tenant: string): Record<string, unknown>;
  cleanup(): Promise<void>;
}

/** A tenant-scoped collection keyed uniquely by (tenant, `sku`). Rows: `{ sku, qty, name, firstSeen }`. */
export interface BulkUpsertFixture {
  bulkUpsert(
    rows: readonly Record<string, unknown>[],
    options: BulkUpsertOptions,
    tenant: string,
  ): Promise<BulkUpsertResult>;
  read(tenant: string): Promise<readonly Record<string, unknown>[]>;
  /** `bulkUpsert` keyed on `name`, which has NO unique index: must be refused. */
  bulkUpsertByNonUniqueKey(
    rows: readonly Record<string, unknown>[],
    tenant: string,
  ): Promise<unknown>;
  cleanup(): Promise<void>;
}

/** Source facts `{ period, rate, tax }` and a totals read model keyed (tenant, period, rate). */
export interface ReadModelFixture {
  seedSource(
    tenant: string,
    rows: ReadonlyArray<{ period: string; rate: number; tax: number }>,
  ): Promise<void>;
  /** Rebuild the tenant's totals from its source facts. */
  rebuild(tenant: string): Promise<void>;
  /** The same rebuild, issued inside a transaction: must reject. */
  rebuildInTransaction(tenant: string): Promise<unknown>;
  /** Drift between the source-derived totals and the read model, for the tenant. */
  reconcile(
    tenant: string,
  ): Promise<ReadonlyArray<{ key: Record<string, unknown>; expected: unknown; actual: unknown }>>;
  /** Corrupt one stored total. */
  tamper(tenant: string, period: string, rate: number): Promise<void>;
  /** Apply increments in one unit of work; a repeated dedupeKey must count once. */
  applyIncrements(
    tenant: string,
    grains: ReadonlyArray<{ period: string; rate: number; tax: number; dedupeKey: string }>,
  ): Promise<void>;
  readTotals(tenant: string): Promise<ReadonlyArray<{ period: string; rate: number; tax: number }>>;
  cleanup(): Promise<void>;
}

export interface DataAccessConformanceHarness {
  name: string;
  features: RepoCapabilities;
  orderedIds?: () => Promise<OrderedIdsFixture>;
  scopedJoin?: () => Promise<ScopedJoinFixture>;
  bulkUpsert?: () => Promise<BulkUpsertFixture>;
  readModel?: () => Promise<ReadModelFixture>;
}

export type DataAccessCapability = 'getByIdsOrdered' | 'scopedJoins' | 'bulkUpsert' | 'readModel';

/** Whether a group runs, is skipped (capability not declared), or fails (declared, no fixture). */
export function dataAccessGroupState(
  features: RepoCapabilities,
  capability: DataAccessCapability,
  fixture: unknown,
): 'run' | 'skip' | 'missing-fixture' {
  if (features[capability] !== true) return 'skip';
  return fixture === undefined ? 'missing-fixture' : 'run';
}

/** A group's fixture lifecycle, owned once here: each case reads the current fixture via `fx()`. */
function gated<F extends { cleanup(): Promise<void> }>(
  harness: DataAccessConformanceHarness,
  capability: DataAccessCapability,
  title: string,
  fixture: (() => Promise<F>) | undefined,
  cases: (fx: () => F) => void,
): void {
  const state = dataAccessGroupState(harness.features, capability, fixture);
  let current: F | undefined;
  const fx = (): F => {
    if (!current) throw new Error(`${title}: fixture not built`);
    return current;
  };
  if (state === 'skip') {
    describe.skip(`${title} [skipped: capability '${capability}' not declared]`, () => cases(fx));
    return;
  }
  if (state === 'missing-fixture') {
    describe(title, () => {
      it(`declares '${capability}' and supplies its fixture`, () => {
        throw new Error(`${harness.name} declares '${capability}' but supplies no fixture for it`);
      });
    });
    return;
  }
  describe(title, () => {
    beforeEach(async () => {
      current = await (fixture as () => Promise<F>)();
    });
    afterEach(async () => {
      await current?.cleanup();
      current = undefined;
    });
    cases(fx);
  });
}

export function runDataAccessConformance(harness: DataAccessConformanceHarness): void {
  describe(`[data-access conformance] ${harness.name}`, () => {
    gated(harness, 'getByIdsOrdered', 'getByIds (ordered, chunked)', harness.orderedIds, (fx) => {
      it('aligns with the input: misses are undefined, duplicates repeat', async () => {
        const [a, b] = await fx().insert(['ord-a', 'ord-b']);
        const out = await fx().getOrdered(
          [b as string, fx().missingId, a as string, b as string],
          {},
        );
        expect(out.map((d) => d?.name)).toEqual(['ord-b', undefined, 'ord-a', 'ord-b']);
      });

      it('gives the same answer at any chunk size', async () => {
        const names = Array.from({ length: 7 }, (_, i) => `chunk-${i}`);
        const ids = await fx().insert(names);
        const shuffled = [...ids].reverse();
        const one = await fx().getOrdered(shuffled, { chunkSize: 1 });
        const all = await fx().getOrdered(shuffled, {});
        expect(one.map((d) => d?.name)).toEqual([...names].reverse());
        expect(all.map((d) => d?.name)).toEqual(one.map((d) => d?.name));
      });
    });

    gated(harness, 'scopedJoins', 'scoped joins', harness.scopedJoin, (fx) => {
      const joinSum = (from: string): AggRequest => ({
        lookups: [{ from, localField: 'key', foreignField: 'key', as: 'j' }],
        groupBy: 'key',
        measures: { n: { op: 'count' } },
      });

      it('a join reads only the caller tenant live rows of the joined collection', async () => {
        await fx().seedBase('t-a', ['shared', 'b-only']);
        await fx().seedBase('t-b', ['shared']);
        await fx().seedJoined('t-a', [
          { key: 'shared', qty: 5 },
          { key: 'shared', qty: 99, deleted: true },
        ]);
        await fx().seedJoined('t-b', [
          { key: 'shared', qty: 7 },
          { key: 'b-only', qty: 3 },
        ]);
        const { rows } = await fx().aggregate(
          {
            lookups: [
              { from: fx().joined, localField: 'key', foreignField: 'key', as: 'j', single: true },
            ],
            groupBy: 'key',
            measures: { qty: { op: 'sum', field: 'j.qty' } },
            sort: { key: 1 },
          },
          fx().scope('t-a'),
        );
        const byKey = Object.fromEntries(rows.map((r) => [String(r['key']), r['qty'] ?? 0]));
        // Shared key: only t-a's live row (5), never t-b's 7 or the deleted 99.
        expect(byKey['shared']).toBe(5);
        // A key only the sibling tenant has joins NOTHING for t-a.
        expect(byKey['b-only']).toBe(0);
      });

      it('a join into a name the kit cannot resolve is refused, not an empty join', async () => {
        await fx().seedBase('t-a', ['shared']);
        // The same request resolves against the real name, so the only failure left is the join.
        await expect(
          fx().aggregate(joinSum(fx().joined), fx().scope('t-a')),
        ).resolves.toBeDefined();
        await expect(
          fx().aggregate(joinSum(`${fx().joined}_no_such_collection`), fx().scope('t-a')),
        ).rejects.toThrow();
      });
    });

    gated(harness, 'bulkUpsert', 'bulkUpsert', harness.bulkUpsert, (fx) => {
      const at = new Date('2026-01-01T00:00:00.000Z');

      it('reports inserted, then updated vs unchanged, per row and in order', async () => {
        const first = await fx().bulkUpsert(
          [
            { sku: 'A', qty: 1, name: 'alpha' },
            { sku: 'B', qty: 2, name: 'beta' },
          ],
          { key: ['sku'] },
          't-a',
        );
        expect(first.results.map((r) => r.outcome)).toEqual(['inserted', 'inserted']);
        expect(first.results.map((r) => r.key)).toEqual([{ sku: 'A' }, { sku: 'B' }]);
        const second = await fx().bulkUpsert(
          [
            { sku: 'A', qty: 1, name: 'alpha' },
            { sku: 'B', qty: 2, name: 'beta-2' },
          ],
          { key: ['sku'] },
          't-a',
        );
        expect(second.results.map((r) => r.outcome)).toEqual(['unchanged', 'updated']);
        expect(second).toMatchObject({ inserted: 0, updated: 1, unchanged: 1, failed: 0 });
      });

      it('inc accumulates and setOnInsert is written once', async () => {
        const opts = { key: ['sku'], inc: ['qty'], setOnInsert: ['firstSeen'] };
        await fx().bulkUpsert([{ sku: 'A', qty: 5, firstSeen: at }], opts, 't-a');
        await fx().bulkUpsert(
          [{ sku: 'A', qty: 7, firstSeen: new Date('2027-01-01T00:00:00.000Z') }],
          opts,
          't-a',
        );
        const [row] = await fx().read('t-a');
        expect(row?.['qty']).toBe(12);
        expect(new Date(String(row?.['firstSeen'])).toISOString()).toBe(at.toISOString());
      });

      it('the tenant scope is part of the key: another tenant row is never touched', async () => {
        const opts = { key: ['sku'], inc: ['qty'] };
        await fx().bulkUpsert([{ sku: 'A', qty: 1 }], opts, 't-b');
        await fx().bulkUpsert([{ sku: 'A', qty: 1 }], opts, 't-a');
        await fx().bulkUpsert([{ sku: 'A', qty: 1 }], opts, 't-a');
        expect((await fx().read('t-a')).map((r) => r['qty'])).toEqual([2]);
        expect((await fx().read('t-b')).map((r) => r['qty'])).toEqual([1]);
      });

      it('a row missing a key field fails alone; the rest land', async () => {
        const res = await fx().bulkUpsert(
          [{ qty: 1 }, { sku: 'C', qty: 3 }],
          { key: ['sku'] },
          't-a',
        );
        expect(res.results.map((r) => [r.outcome, r.code])).toEqual([
          ['failed', 'invalid_row'],
          ['inserted', undefined],
        ]);
      });

      it('a key without a unique index is refused before any write', async () => {
        await expect(
          fx().bulkUpsertByNonUniqueKey([{ sku: 'Z', name: 'zed', qty: 1 }], 't-a'),
        ).rejects.toThrow();
        expect(await fx().read('t-a')).toHaveLength(0);
      });

      it('a field routed twice is refused', async () => {
        await expect(
          fx().bulkUpsert(
            [{ sku: 'A', qty: 1 }],
            { key: ['sku'], inc: ['qty'], set: ['qty'] },
            't-a',
          ),
        ).rejects.toThrow();
      });
    });

    gated(harness, 'readModel', 'read model', harness.readModel, (fx) => {
      const facts = [
        { period: '2026-01', rate: 15, tax: 100 },
        { period: '2026-01', rate: 15, tax: 50 },
        { period: '2026-01', rate: 5, tax: 7 },
        { period: '2026-02', rate: 15, tax: 30 },
      ];
      const byGrain = (rows: ReadonlyArray<{ period: string; rate: number; tax: number }>) =>
        rows
          .map((t) => [t.period, t.rate, t.tax])
          .sort((a, b) => String(a).localeCompare(String(b)));

      it('rebuild then reconcile reports zero drift', async () => {
        await fx().seedSource('t-a', facts);
        await fx().rebuild('t-a');
        expect(await fx().reconcile('t-a')).toEqual([]);
        expect(byGrain(await fx().readTotals('t-a'))).toEqual(
          byGrain([
            { period: '2026-01', rate: 15, tax: 150 },
            { period: '2026-01', rate: 5, tax: 7 },
            { period: '2026-02', rate: 15, tax: 30 },
          ]),
        );
      });

      it('reconcile reports a corrupted total with its expected and actual value', async () => {
        await fx().seedSource('t-a', facts);
        await fx().rebuild('t-a');
        await fx().tamper('t-a', '2026-01', 15);
        const drift = await fx().reconcile('t-a');
        expect(drift).toHaveLength(1);
        expect(drift[0]?.key).toMatchObject({ period: '2026-01', rate: 15 });
        expect(drift[0]?.expected).not.toEqual(drift[0]?.actual);
      });

      it('rebuilding one tenant never touches another tenant read model', async () => {
        await fx().seedSource('t-a', facts);
        await fx().seedSource('t-b', [{ period: '2026-01', rate: 15, tax: 1 }]);
        await fx().rebuild('t-b');
        await fx().rebuild('t-a');
        expect((await fx().readTotals('t-b')).map((t) => t.tax)).toEqual([1]);
      });

      it('applyIncrements counts a repeated dedupeKey once', async () => {
        await fx().applyIncrements('t-a', [
          { period: '2026-03', rate: 15, tax: 10, dedupeKey: 'e1' },
          { period: '2026-03', rate: 15, tax: 5, dedupeKey: 'e2' },
        ]);
        await fx().applyIncrements('t-a', [
          { period: '2026-03', rate: 15, tax: 10, dedupeKey: 'e1' },
          { period: '2026-03', rate: 15, tax: 5, dedupeKey: 'e3' },
        ]);
        expect((await fx().readTotals('t-a')).map((t) => t.tax)).toEqual([20]);
      });

      it('a rebuild inside a transaction is refused', async () => {
        await fx().seedSource('t-a', facts);
        await expect(fx().rebuildInTransaction('t-a')).rejects.toThrow();
      });
    });
  });
}
