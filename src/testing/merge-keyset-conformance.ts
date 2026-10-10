/**
 * `mergeKeysetPages` over a kit's real sources (fast-check), gated by
 * `RepoCapabilities.mergeKeyset`: two sources ordered by the same total order (descending key),
 * merged to the end, equal the sorted union with every row once, also when rows are inserted
 * between pages. An undeclared capability is a skipped group naming it.
 */

import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { type KeysetSource, mergeKeysetPages } from '../pagination/merge-keyset.js';
import type { RepoCapabilities } from '../repository/capabilities.js';

export interface MergeKeysetFixture {
  /** Insert into source 0 or 1; `k` is a small integer sort key (ties expected), `label` unique. */
  insert(source: 0 | 1, rows: ReadonlyArray<{ k: number; label: string }>): Promise<void>;
  /** Fresh sources over the two collections, in source order. */
  sources(): readonly KeysetSource<unknown>[];
  sort: Readonly<Record<string, 1 | -1>>;
  labelOf(row: unknown): string;
  /** The sort key of a row, comparable as a number (larger first: the sort is descending). */
  keyOf(row: unknown): number;
  cleanup(): Promise<void>;
}

export interface MergeKeysetHarness {
  name: string;
  features: RepoCapabilities;
  fixture?: () => Promise<MergeKeysetFixture>;
  numRuns?: number;
}

export function runMergeKeysetConformance(harness: MergeKeysetHarness): void {
  const title = `[merge keyset] ${harness.name}`;
  if (harness.features.mergeKeyset !== true) {
    describe.skip(`${title} [skipped: capability 'mergeKeyset' not declared]`, () => {
      it('skipped', () => undefined);
    });
    return;
  }
  describe(title, () => {
    if (!harness.fixture) {
      it("declares 'mergeKeyset' and supplies its fixture", () => {
        throw new Error(`${harness.name} declares 'mergeKeyset' but supplies no fixture`);
      });
      return;
    }
    const make = harness.fixture;
    it('a merged walk equals the sorted union, each row once, with inserts between pages', async () => {
      await fc.assert(
        fc.asyncProperty(
          fc.array(fc.integer({ min: 0, max: 5 }), { maxLength: 12 }),
          fc.array(fc.integer({ min: 0, max: 5 }), { maxLength: 12 }),
          fc.integer({ min: 1, max: 5 }),
          fc.array(fc.tuple(fc.constantFrom<0 | 1>(0, 1), fc.integer({ min: 0, max: 5 })), {
            maxLength: 4,
          }),
          async (a, b, limit, inserts) => {
            const f = await make();
            try {
              await f.insert(
                0,
                a.map((k, i) => ({ k, label: `a${i}` })),
              );
              await f.insert(
                1,
                b.map((k, i) => ({ k, label: `b${i}` })),
              );
              const seen: { label: string; key: number }[] = [];
              let cursor: string | undefined;
              for (let step = 0; step < 200; step++) {
                const page = await mergeKeysetPages(f.sources(), {
                  sort: f.sort,
                  limit,
                  ...(cursor ? { cursor } : {}),
                });
                seen.push(
                  ...page.docs.map((d) => ({ label: f.labelOf(d.row), key: f.keyOf(d.row) })),
                );
                const ins = inserts[step];
                if (ins) await f.insert(ins[0], [{ k: ins[1], label: `z${step}` }]);
                if (!page.hasNext) break;
                cursor = page.next ?? undefined;
              }
              const labels = seen.map((s) => s.label);
              expect(new Set(labels).size).toBe(labels.length);
              for (let i = 0; i < a.length; i++) expect(labels).toContain(`a${i}`);
              for (let i = 0; i < b.length; i++) expect(labels).toContain(`b${i}`);
              const keys = seen.map((s) => s.key);
              expect(keys).toEqual([...keys].sort((x, y) => y - x));
            } finally {
              await f.cleanup();
            }
          },
        ),
        { numRuns: harness.numRuns ?? 15 },
      );
    });
  });
}
