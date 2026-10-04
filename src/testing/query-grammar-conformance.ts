/**
 * `runQueryGrammarConformance` — every list-query parser reads a URL the same way.
 *
 * Cases are SEMANTIC: each parser's output is evaluated against one fixture set and must select
 * the same rows (or refuse the same input with a 400). A parser passes by agreeing on RESULTS,
 * so its emitted shape (Filter IR, Mongo record, a custom dialect) is free.
 */

import { describe, expect, it } from 'vitest';

export interface QueryGrammarCaseOptions {
  readonly maxLimit: number;
  readonly defaultLimit: number;
  readonly allowedFilterFields?: readonly string[];
  readonly allowedSortFields?: readonly string[];
}

/** What a harness returns for one parsed query. */
export interface QueryGrammarParsed {
  /** True when the parsed filter selects `doc`. */
  matches(doc: Readonly<Record<string, unknown>>): boolean;
  readonly limit: number;
  readonly page?: number | undefined;
  readonly after?: string | undefined;
  readonly sort?: Readonly<Record<string, 1 | -1>> | undefined;
}

export interface QueryGrammarHarness {
  /** Parse a raw query string exactly as the kit receives one in production. Throw to refuse. */
  parse(query: string, options: QueryGrammarCaseOptions): QueryGrammarParsed;
}

const at = (iso: string): Date => new Date(iso);

/** The fixture every case runs against: nulls, missing fields, codes, dates, and text metacharacters. */
export const QUERY_GRAMMAR_DOCS: readonly Readonly<Record<string, unknown>>[] = [
  {
    _id: 'a',
    status: 'active',
    qty: 5,
    code: '007',
    name: 'Blue Hoodie',
    price: 10,
    tags: ['x'],
    createdAt: at('2026-09-01T00:00:00Z'),
    note: '50% off',
    deletedAt: null,
  },
  {
    _id: 'b',
    status: 'draft',
    qty: 12,
    code: '7',
    name: 'blue cap',
    price: 100,
    createdAt: at('2026-09-15T00:00:00Z'),
    note: 'a.b',
  },
  {
    _id: 'c',
    status: 'archived',
    qty: 0,
    code: '0123',
    name: 'Red Hoodie',
    price: 55.5,
    tags: [],
    createdAt: at('2026-10-02T00:00:00Z'),
    deletedAt: at('2026-10-03T00:00:00Z'),
  },
  { _id: 'd', name: 'Green', price: 7 },
  { _id: 'e', status: null, name: 'HOODIE', price: 0, note: 'axb' },
];

const DEFAULT_OPTIONS: QueryGrammarCaseOptions = { maxLimit: 100, defaultLimit: 20 };

interface FilterCase {
  readonly query: string;
  readonly ids: readonly string[];
  readonly options?: Partial<QueryGrammarCaseOptions>;
}

export const QUERY_GRAMMAR_FILTER_CASES: readonly FilterCase[] = [
  { query: 'status=active', ids: ['a'] },
  { query: 'status=active&status=draft', ids: ['a', 'b'] },
  { query: 'status[in]=active,draft', ids: ['a', 'b'] },
  { query: 'status[in]=active&status[in]=draft', ids: ['a', 'b'] },
  { query: 'status=active&status[in]=draft,archived', ids: ['a', 'b', 'c'] },
  { query: 'status[nin]=active&status[ne]=draft', ids: ['c'] },
  { query: 'status[nin]=active,draft', ids: ['c'] },
  // A null member: `in` adds IS NULL (null or missing); `nin` excludes null and missing anyway.
  { query: 'status[in]=null,active', ids: ['a', 'd', 'e'] },
  { query: 'status[nin]=null,active', ids: ['b', 'c'] },
  { query: 'status[ne]=active', ids: ['b', 'c'] },
  { query: 'status[exists]=true', ids: ['a', 'b', 'c'] },
  { query: 'status[exists]=false', ids: ['d', 'e'] },
  { query: 'filter[status]=active', ids: ['a'] },
  { query: 'status=', ids: ['a', 'b', 'c', 'd', 'e'] },
  { query: 'qty=5', ids: ['a'] },
  { query: 'qty[in]=5,12', ids: ['a', 'b'] },
  { query: 'qty[gte]=5', ids: ['a', 'b'] },
  { query: 'qty[lt]=5', ids: ['c'] },
  { query: 'code=007', ids: ['a'] },
  { query: 'code=0123', ids: ['c'] },
  { query: 'price[gte]=10&price[lte]=100', ids: ['a', 'b', 'c'] },
  { query: 'price[between]=10,60', ids: ['a', 'c'] },
  { query: 'price[between]=,9', ids: ['d', 'e'] },
  { query: 'price=10&price[gte]=1', ids: ['a'] },
  { query: 'createdAt[gte]=2026-09-10', ids: ['b', 'c'] },
  { query: 'createdAt[between]=2026-09-01,2026-09-30', ids: ['a', 'b'] },
  { query: 'name[contains]=hoodie', ids: ['a', 'c', 'e'] },
  { query: 'name[like]=hoodie', ids: ['a', 'c', 'e'] },
  { query: 'name[startsWith]=blue', ids: ['a', 'b'] },
  { query: 'name[endsWith]=hoodie', ids: ['a', 'c', 'e'] },
  { query: 'name[ieq]=hoodie', ids: ['e'] },
  { query: 'note[contains]=a.b', ids: ['b'] },
  { query: 'note[contains]=50%25', ids: ['a'] },
  { query: 'name[regex]=^Blue', ids: ['a'] },
  { query: 'name[regex]=^blue&name[options]=i', ids: ['a', 'b'] },
  { query: 'deletedAt=null', ids: ['a', 'b', 'd', 'e'] },
  { query: 'tags[exists]=false', ids: ['b', 'd', 'e'] },
  { query: 'status=active', ids: ['a'], options: { allowedFilterFields: ['status'] } },
];

export const QUERY_GRAMMAR_REFUSED: readonly {
  query: string;
  options?: Partial<QueryGrammarCaseOptions>;
}[] = [
  { query: 'x[foo]=1' },
  { query: 'meta[color]=red' },
  { query: 'meta[color][shade]=red' },
  { query: 'status[$ne]=x' },
  { query: '$where=1' },
  { query: 'name[regex]=(a%2B)%2B' },
  { query: 'status[exists]=maybe' },
  { query: 'price[between]=1' },
  { query: 'price[between]=1,2,3' },
  { query: 'qty[gte]=null' },
  { query: 'name[options]=i' },
  { query: 'name[regex]=a&name[options]=g' },
  { query: 'price=1', options: { allowedFilterFields: ['status'] } },
  { query: 'limit=0' },
  { query: 'limit=-1' },
  { query: 'limit=abc' },
  { query: 'limit=1.5' },
  { query: 'page=0' },
  { query: 'page=abc' },
  { query: 'sort=name;DROP' },
  { query: 'sort=$x' },
  { query: 'sort=price', options: { allowedSortFields: ['name'] } },
];

export const QUERY_GRAMMAR_PAGING_CASES: readonly {
  query: string;
  expect: { limit: number; page?: number; after?: string; sort?: Record<string, 1 | -1> };
}[] = [
  { query: '', expect: { limit: 20 } },
  { query: 'limit=5', expect: { limit: 5 } },
  { query: 'limit=500', expect: { limit: 100 } },
  { query: 'page=2', expect: { limit: 20, page: 2 } },
  { query: 'after=abc', expect: { limit: 20, after: 'abc' } },
  { query: 'sort=-createdAt,name', expect: { limit: 20, sort: { createdAt: -1, name: 1 } } },
];

function statusOf(error: unknown): number | undefined {
  const e = error as { status?: unknown; statusCode?: unknown };
  const status = e?.status ?? e?.statusCode;
  return typeof status === 'number' ? status : undefined;
}

/** Register the suite for one parser. */
export interface QueryGrammarConformanceOptions {
  /**
   * Operators this backend cannot execute (e.g. `regex` on SQLite without REGEXP). A case using
   * one must be REFUSED with a 400 — the kit's parser declares them out, it never fails at query
   * time.
   */
  readonly unsupportedOperators?: readonly string[];
}

const refusedWith400 = (attempt: () => unknown, query: string): void => {
  let caught: unknown;
  try {
    attempt();
  } catch (error) {
    caught = error;
  }
  expect(caught, `?${query} was accepted`).toBeDefined();
  expect(statusOf(caught)).toBe(400);
};

export function runQueryGrammarConformance(
  name: string,
  harness: QueryGrammarHarness,
  conformance: QueryGrammarConformanceOptions = {},
): void {
  const parse = (query: string, options?: Partial<QueryGrammarCaseOptions>) =>
    harness.parse(query, { ...DEFAULT_OPTIONS, ...options });
  const unsupported = conformance.unsupportedOperators ?? [];
  const usesUnsupported = (query: string): boolean =>
    unsupported.some((op) => query.includes(`[${op}]`));

  describe(`query grammar conformance — ${name}`, () => {
    describe('filters select the same rows', () => {
      for (const { query, ids, options } of QUERY_GRAMMAR_FILTER_CASES) {
        it(`?${query}${options ? ` ${JSON.stringify(options)}` : ''}`, () => {
          if (usesUnsupported(query)) {
            refusedWith400(() => parse(query, options), query);
            return;
          }
          const parsed = parse(query, options);
          const matched = QUERY_GRAMMAR_DOCS.filter((doc) => parsed.matches(doc)).map(
            (doc) => doc['_id'],
          );
          expect(matched).toEqual([...ids]);
        });
      }
    });

    describe('invalid input is refused with a 400, never dropped', () => {
      for (const { query, options } of QUERY_GRAMMAR_REFUSED) {
        it(`?${query}${options ? ` ${JSON.stringify(options)}` : ''}`, () => {
          refusedWith400(() => parse(query, options), query);
        });
      }
    });

    describe('paging and sort', () => {
      for (const { query, expect: want } of QUERY_GRAMMAR_PAGING_CASES) {
        it(`?${query}`, () => {
          const parsed = parse(query);
          expect(parsed.limit).toBe(want.limit);
          if (want.page !== undefined) expect(parsed.page).toBe(want.page);
          if (want.after !== undefined) expect(parsed.after).toBe(want.after);
          if (want.sort !== undefined) expect(parsed.sort).toEqual(want.sort);
        });
      }
    });
  });
}
