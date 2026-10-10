/**
 * Data-access conformance: behaviour groups a kit OPTS INTO through `RepoCapabilities`.
 *
 * Each group runs only when its capability is declared. An undeclared one is reported as a
 * skipped group whose title names the missing capability (never a silent pass), and a declared
 * capability without its fixture fails, because an unproven declaration is decoration (FL4).
 * Groups: `getByIdsOrdered`, `scopedJoins`.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
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
  seedJoined(tenant: string, rows: ReadonlyArray<{ key: string; qty: number; deleted?: boolean }>): Promise<void>;
  /** Call options that scope a read to `tenant`. */
  scope(tenant: string): Record<string, unknown>;
  cleanup(): Promise<void>;
}

export interface DataAccessConformanceHarness {
  name: string;
  features: RepoCapabilities;
  orderedIds?: () => Promise<OrderedIdsFixture>;
  scopedJoin?: () => Promise<ScopedJoinFixture>;
}

export type DataAccessCapability = 'getByIdsOrdered' | 'scopedJoins';

/** Whether a group runs, is skipped (capability not declared), or fails (declared, no fixture). */
export function dataAccessGroupState(
  features: RepoCapabilities,
  capability: DataAccessCapability,
  fixture: unknown,
): 'run' | 'skip' | 'missing-fixture' {
  if (features[capability] !== true) return 'skip';
  return fixture === undefined ? 'missing-fixture' : 'run';
}

function gated(
  harness: DataAccessConformanceHarness,
  capability: DataAccessCapability,
  title: string,
  fixture: unknown,
  body: () => void,
): void {
  const state = dataAccessGroupState(harness.features, capability, fixture);
  if (state === 'skip') {
    describe.skip(`${title} [skipped: capability '${capability}' not declared]`, body);
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
  describe(title, body);
}

export function runDataAccessConformance(harness: DataAccessConformanceHarness): void {
  describe(`[data-access conformance] ${harness.name}`, () => {
    gated(harness, 'getByIdsOrdered', 'getByIds (ordered, chunked)', harness.orderedIds, () => {
      let f: OrderedIdsFixture;
      beforeEach(async () => {
        f = await (harness.orderedIds as () => Promise<OrderedIdsFixture>)();
      });
      afterEach(async () => f.cleanup());

      it('aligns with the input: misses are undefined, duplicates repeat', async () => {
        const [a, b] = await f.insert(['ord-a', 'ord-b']);
        const out = await f.getOrdered([b as string, f.missingId, a as string, b as string], {});
        expect(out.map((d) => d?.name)).toEqual(['ord-b', undefined, 'ord-a', 'ord-b']);
      });

      it('gives the same answer at any chunk size', async () => {
        const names = Array.from({ length: 7 }, (_, i) => `chunk-${i}`);
        const ids = await f.insert(names);
        const shuffled = [...ids].reverse();
        const one = await f.getOrdered(shuffled, { chunkSize: 1 });
        const all = await f.getOrdered(shuffled, {});
        expect(one.map((d) => d?.name)).toEqual([...names].reverse());
        expect(all.map((d) => d?.name)).toEqual(one.map((d) => d?.name));
      });
    });

    gated(harness, 'scopedJoins', 'scoped joins', harness.scopedJoin, () => {
      let f: ScopedJoinFixture;
      beforeEach(async () => {
        f = await (harness.scopedJoin as () => Promise<ScopedJoinFixture>)();
      });
      afterEach(async () => f.cleanup());

      const joinSum = (from: string): AggRequest => ({
        lookups: [{ from, localField: 'key', foreignField: 'key', as: 'j' }],
        groupBy: 'key',
        measures: { n: { op: 'count' } },
      });

      it('a join reads only the caller tenant live rows of the joined collection', async () => {
        await f.seedBase('t-a', ['shared', 'b-only']);
        await f.seedBase('t-b', ['shared']);
        await f.seedJoined('t-a', [
          { key: 'shared', qty: 5 },
          { key: 'shared', qty: 99, deleted: true },
        ]);
        await f.seedJoined('t-b', [
          { key: 'shared', qty: 7 },
          { key: 'b-only', qty: 3 },
        ]);
        const { rows } = await f.aggregate(
          {
            lookups: [{ from: f.joined, localField: 'key', foreignField: 'key', as: 'j', single: true }],
            groupBy: 'key',
            measures: { qty: { op: 'sum', field: 'j.qty' } },
            sort: { key: 1 },
          },
          f.scope('t-a'),
        );
        const byKey = Object.fromEntries(rows.map((r) => [String(r['key']), r['qty'] ?? 0]));
        // Shared key: only t-a's live row (5), never t-b's 7 or the deleted 99.
        expect(byKey['shared']).toBe(5);
        // A key only the sibling tenant has joins NOTHING for t-a.
        expect(byKey['b-only']).toBe(0);
      });

      it('a join into a name the kit cannot resolve is refused, not an empty join', async () => {
        await f.seedBase('t-a', ['shared']);
        // The same request resolves against the real name, so the only failure left is the join.
        await expect(f.aggregate(joinSum(f.joined), f.scope('t-a'))).resolves.toBeDefined();
        await expect(f.aggregate(joinSum(`${f.joined}_no_such_collection`), f.scope('t-a'))).rejects.toThrow();
      });
    });
  });
}
