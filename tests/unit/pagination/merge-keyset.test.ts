/**
 * `mergeKeysetPages` (fast-check): paging a merge to the end equals the in-memory merge of all
 * rows; no gap / no duplicate under concurrent inserts; ties across sources stable (source order);
 * empty and early-exhausted sources; a tampered, foreign or rescoped composite cursor is refused.
 */

import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import {
  type KeysetSource,
  MERGE_CURSOR_ERROR_CODES,
  mergeKeysetPages,
} from '../../../src/pagination/index.js';

interface Row {
  id: string;
  k: number | null;
}

/** An in-memory keyset source ordered by (k asc/desc, id asc), mutable to simulate inserts. */
function memSource(
  name: string,
  rows: Row[],
  dir: 1 | -1,
  scope = 's',
): KeysetSource<Row> & { rows: Row[] } {
  const cmp = (a: Row, b: Row) => {
    const ka = a.k ?? Number.NEGATIVE_INFINITY;
    const kb = b.k ?? Number.NEGATIVE_INFINITY;
    if (ka !== kb) return (ka < kb ? -1 : 1) * dir;
    return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
  };
  const src = {
    name,
    scope,
    rows,
    async page({ after, limit }: { after?: string; limit: number }) {
      const sorted = [...src.rows].sort(cmp);
      const at = after ? (JSON.parse(after) as Row) : undefined;
      const rest = at ? sorted.filter((r) => cmp(r, at) > 0) : sorted;
      return { data: rest.slice(0, limit), hasMore: rest.length > limit };
    },
    cursorOf: (row: Row) => JSON.stringify(row),
  };
  return src;
}

const sortOf = (dir: 1 | -1) => ({ k: dir, id: 1 as const });

async function walk<T>(
  sources: readonly KeysetSource<T>[],
  sort: Record<string, 1 | -1>,
  limit: number,
  between?: (i: number) => void,
) {
  const out: { source: string; row: T }[] = [];
  let cursor: string | undefined;
  for (let i = 0; i < 1000; i++) {
    const page = await mergeKeysetPages(sources, { sort, limit, ...(cursor ? { cursor } : {}) });
    out.push(...page.docs);
    if (!page.hasNext) return out;
    cursor = page.next ?? undefined;
    between?.(i);
  }
  throw new Error('merge walk did not terminate');
}

const rowsArb = (prefix: string) =>
  fc
    .array(fc.option(fc.integer({ min: -3, max: 3 }), { nil: null }), { maxLength: 15 })
    .map((ks) => ks.map((k, i) => ({ id: `${prefix}${String(i).padStart(3, '0')}`, k })));

describe('mergeKeysetPages', () => {
  it('paging to the end equals the in-memory merge (ties: source order), for any limit', async () => {
    await fc.assert(
      fc.asyncProperty(
        rowsArb('a'),
        rowsArb('b'),
        rowsArb('c'),
        fc.constantFrom<1 | -1>(1, -1),
        fc.integer({ min: 1, max: 7 }),
        async (a, b, c, dir, limit) => {
          const sources = [memSource('A', a, dir), memSource('B', b, dir), memSource('C', c, dir)];
          const got = await walk(sources, sortOf(dir), limit);
          const key = (r: Row) => r.k ?? Number.NEGATIVE_INFINITY;
          const expected = [
            ...a.map((row) => ({ source: 'A', row, s: 0 })),
            ...b.map((row) => ({ source: 'B', row, s: 1 })),
            ...c.map((row) => ({ source: 'C', row, s: 2 })),
          ]
            .sort((x, y) =>
              key(x.row) !== key(y.row)
                ? (key(x.row) - key(y.row)) * dir
                : x.row.id !== y.row.id
                  ? x.row.id < y.row.id
                    ? -1
                    : 1
                  : x.s - y.s,
            )
            .map(({ source, row }) => ({ source, row }));
          expect(got).toEqual(expected);
        },
      ),
      { numRuns: 60 },
    );
  });

  it('under concurrent inserts every pre-existing row appears exactly once', async () => {
    await fc.assert(
      fc.asyncProperty(
        rowsArb('a'),
        rowsArb('b'),
        fc.array(fc.tuple(fc.boolean(), fc.integer({ min: -3, max: 3 })), { maxLength: 8 }),
        async (a, b, inserts) => {
          const A = memSource('A', [...a], 1);
          const B = memSource('B', [...b], 1);
          const got = await walk([A, B], sortOf(1), 3, (i) => {
            const ins = inserts[i];
            if (ins) (ins[0] ? A : B).rows.push({ id: `z${i}`, k: ins[1] });
          });
          const ids = got.map((g) => `${g.source}:${g.row.id}`);
          expect(new Set(ids).size).toBe(ids.length);
          for (const r of a) expect(ids).toContain(`A:${r.id}`);
          for (const r of b) expect(ids).toContain(`B:${r.id}`);
        // Never out of order, even for rows inserted into a source that emitted nothing yet.
        const keys = got.map((g) => g.row.k ?? Number.NEGATIVE_INFINITY);
        expect(keys).toEqual([...keys].sort((x, y) => x - y));
        },
      ),
      { numRuns: 60 },
    );
  });

  it('an empty source and an early-exhausted source are fine', async () => {
    const got = await walk(
      [
        memSource('A', [], 1),
        memSource('B', [{ id: 'b1', k: 9 }], 1),
        memSource(
          'C',
          [1, 2, 3, 4, 5].map((k) => ({ id: `c${k}`, k })),
          1,
        ),
      ],
      sortOf(1),
      2,
    );
    expect(got.map((g) => g.row.id)).toEqual(['c1', 'c2', 'c3', 'c4', 'c5', 'b1']);
  });

  describe('composite cursor integrity', () => {
    const SECRET = 'merge-keyset-secret-0123456789abcdef';
    const two = () => [
      memSource(
        'A',
        [1, 2, 3].map((k) => ({ id: `a${k}`, k })),
        1,
      ),
      memSource(
        'B',
        [1, 2].map((k) => ({ id: `b${k}`, k })),
        1,
      ),
    ];
    const first = async () =>
      (await mergeKeysetPages(two(), { sort: sortOf(1), limit: 2, secret: SECRET })).next as string;
    const code = async (p: Promise<unknown>) =>
      p.then(
        () => undefined,
        (e: { code?: string; status?: number }) => [e.status, e.code],
      );

    it('a tampered or truncated cursor is invalid (400)', async () => {
      const c = await first();
      const flipped = `${c.slice(0, 5)}${c[5] === 'A' ? 'B' : 'A'}${c.slice(6)}`;
      for (const bad of [flipped, c.slice(0, -3), 'nope']) {
        expect(
          await code(
            mergeKeysetPages(two(), { sort: sortOf(1), limit: 2, cursor: bad, secret: SECRET }),
          ),
        ).toEqual([400, MERGE_CURSOR_ERROR_CODES.INVALID]);
      }
    });

    it('a cursor for other sources, another source scope or another sort is a scope mismatch', async () => {
      const c = await first();
      const renamed = [memSource('A', [], 1), memSource('X', [], 1)];
      const rescoped = [memSource('A', [], 1), memSource('B', [], 1, 'other-tenant')];
      for (const [sources, sort] of [
        [renamed, sortOf(1)],
        [rescoped, sortOf(1)],
        [two(), sortOf(-1)],
      ] as const) {
        expect(
          await code(mergeKeysetPages(sources, { sort, limit: 2, cursor: c, secret: SECRET })),
        ).toEqual([400, MERGE_CURSOR_ERROR_CODES.SCOPE_MISMATCH]);
      }
    });

    it('source names must be unique and limit positive', async () => {
      await expect(
        mergeKeysetPages([memSource('A', [], 1), memSource('A', [], 1)], {
          sort: sortOf(1),
          limit: 2,
        }),
      ).rejects.toThrow(/unique/);
      await expect(mergeKeysetPages(two(), { sort: sortOf(1), limit: 0 })).rejects.toThrow(/limit/);
    });
  });
});
