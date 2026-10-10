/**
 * Pagination properties (fast-check), gated by `RepoCapabilities.paginationProperties`.
 *
 * - a full keyset walk equals an in-memory sort of the same rows (nulls first ascending, last
 *   descending; ties broken by id), for a numeric-nullable and a string key;
 * - under inserts, deletes and sort-key updates between pages, every row untouched during the
 *   walk is returned exactly once (no duplicate, no gap). A row whose key MOVED may be met
 *   twice or not at all; no keyset scheme can promise more for a row that changed position;
 * - an offset page never repeats a row.
 * Requires `fast-check` in the consumer's devDependencies (like `vitest`). An undeclared
 * capability is reported as a skipped group naming it; a declared one without a fixture fails.
 */

import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import type { RepoCapabilities } from '../repository/capabilities.js';

export interface PropertyRow {
  id: string;
  k: number | null;
  s: string;
}

export interface PaginationPropertyFixture {
  /** Insert rows (`k` may be null); returns their ids in order. */
  insert(rows: ReadonlyArray<{ k: number | null; s: string }>): Promise<string[]>;
  update(id: string, k: number | null): Promise<void>;
  remove(id: string): Promise<void>;
  keysetPage(params: {
    sort: Record<string, 1 | -1>;
    limit: number;
    after?: string;
  }): Promise<{ data: PropertyRow[]; next: string | null }>;
  offsetPage(params: {
    sort: Record<string, 1 | -1>;
    page: number;
    limit: number;
  }): Promise<{ data: PropertyRow[] }>;
  /** Remove every row (called between property runs). */
  reset(): Promise<void>;
  cleanup(): Promise<void>;
}

export interface PaginationPropertyHarness {
  name: string;
  features: RepoCapabilities;
  fixture?: () => Promise<PaginationPropertyFixture>;
  /** fast-check runs per property. Default 15. */
  numRuns?: number;
}

const rowArb = fc.record({
  k: fc.option(fc.integer({ min: -5, max: 5 }), { nil: null }),
  s: fc.constantFrom('a', 'b', 'c', 'aa', 'ab'),
});

function compare(a: PropertyRow, b: PropertyRow, field: 'k' | 's', dir: 1 | -1): number {
  const av = a[field];
  const bv = b[field];
  // Null sorts before every value ascending (BSON and SQLite agree); descending reverses it.
  const base = av === bv ? 0 : av === null ? -1 : bv === null ? 1 : av < bv ? -1 : 1;
  return base * dir;
}

async function walkKeyset(
  f: PaginationPropertyFixture,
  sort: Record<string, 1 | -1>,
  limit: number,
  between?: (step: number) => Promise<void>,
): Promise<PropertyRow[]> {
  const out: PropertyRow[] = [];
  let after: string | undefined;
  for (let step = 0; step < 500; step++) {
    const page = await f.keysetPage({ sort, limit, ...(after ? { after } : {}) });
    out.push(...page.data);
    if (!page.next) return out;
    after = page.next;
    if (between) await between(step);
  }
  throw new Error('keyset walk did not terminate in 500 pages');
}

export function runPaginationPropertyConformance(harness: PaginationPropertyHarness): void {
  const title = `[pagination properties] ${harness.name}`;
  if (harness.features.paginationProperties !== true) {
    describe.skip(`${title} [skipped: capability 'paginationProperties' not declared]`, () => {
      it('skipped', () => undefined);
    });
    return;
  }
  const numRuns = harness.numRuns ?? 15;
  describe(title, () => {
    if (!harness.fixture) {
      it("declares 'paginationProperties' and supplies its fixture", () => {
        throw new Error(`${harness.name} declares 'paginationProperties' but supplies no fixture`);
      });
      return;
    }
    const make = harness.fixture;

    it('a full keyset walk equals an in-memory sort (nulls, ties)', async () => {
      const f = await make();
      try {
        await fc.assert(
          fc.asyncProperty(
            fc.array(rowArb, { minLength: 0, maxLength: 25 }),
            fc.constantFrom<'k' | 's'>('k', 's'),
            fc.constantFrom<1 | -1>(1, -1),
            fc.integer({ min: 1, max: 6 }),
            async (rows, field, dir, limit) => {
              await f.reset();
              await f.insert(rows);
              const walked = await walkKeyset(f, { [field]: dir }, limit);
              expect(new Set(walked.map((r) => r.id)).size).toBe(rows.length);
              const keys = walked.map((r) => r[field]);
              const sorted = [...walked]
                .sort((a, b) => compare(a, b, field, dir))
                .map((r) => r[field]);
              expect(keys).toEqual(sorted);
            },
          ),
          { numRuns },
        );
      } finally {
        await f.cleanup();
      }
    });

    it('a keyset walk under concurrent writes returns every untouched row exactly once', async () => {
      const f = await make();
      try {
        await fc.assert(
          fc.asyncProperty(
            fc.array(rowArb, { minLength: 5, maxLength: 25 }),
            fc.array(
              fc.oneof(
                fc.record({ op: fc.constant('insert' as const), row: rowArb }),
                fc.record({ op: fc.constant('delete' as const), at: fc.nat() }),
                fc.record({
                  op: fc.constant('move' as const),
                  at: fc.nat(),
                  k: fc.option(fc.integer({ min: -5, max: 5 }), { nil: null }),
                }),
              ),
              { maxLength: 12 },
            ),
            fc.constantFrom<1 | -1>(1, -1),
            async (rows, ops, dir) => {
              await f.reset();
              const ids = await f.insert(rows);
              const touched = new Set<string>();
              const live = [...ids];
              const walked = await walkKeyset(f, { k: dir }, 3, async (step) => {
                const op = ops[step];
                if (!op) return;
                if (op.op === 'insert') {
                  const [id] = await f.insert([op.row]);
                  if (id) touched.add(id);
                } else if (live.length > 0) {
                  const id = live[op.at % live.length] as string;
                  touched.add(id);
                  if (op.op === 'delete') {
                    live.splice(live.indexOf(id), 1);
                    await f.remove(id);
                  } else {
                    await f.update(id, op.k);
                  }
                }
              });
              const seen = walked.map((r) => r.id);
              for (const id of ids) {
                if (touched.has(id)) continue;
                expect(
                  seen.filter((x) => x === id),
                  `untouched row ${id}`,
                ).toHaveLength(1);
              }
            },
          ),
          { numRuns },
        );
      } finally {
        await f.cleanup();
      }
    });

    it('an offset page never repeats a row', async () => {
      const f = await make();
      try {
        await fc.assert(
          fc.asyncProperty(
            fc.array(rowArb, { minLength: 1, maxLength: 25 }),
            fc.integer({ min: 1, max: 6 }),
            fc.integer({ min: 1, max: 5 }),
            async (rows, limit, page) => {
              await f.reset();
              await f.insert(rows);
              const { data } = await f.offsetPage({ sort: { s: 1 }, page, limit });
              expect(new Set(data.map((r) => r.id)).size).toBe(data.length);
            },
          ),
          { numRuns },
        );
      } finally {
        await f.cleanup();
      }
    });
  });
}
