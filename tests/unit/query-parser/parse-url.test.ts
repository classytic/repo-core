import { describe, expect, it } from 'vitest';
import type { Filter } from '../../../src/filter/index.js';
import {
  isControlParam,
  parseUrl,
  QueryGrammarError,
  STANDARD_RESERVED_PARAMS,
} from '../../../src/query-parser/index.js';

/** Helper — parseUrl from an object (the arc/fluid frontends hand this shape in). */
function parse(obj: Record<string, string | string[]>, options?: Parameters<typeof parseUrl>[1]) {
  return parseUrl(obj, options);
}

describe('parseUrl — basics', () => {
  it('empty URL yields TRUE filter + default limit', () => {
    const result = parse({});
    expect(result.filter).toEqual({ op: 'true' });
    expect(result.limit).toBe(20);
    expect(result.page).toBeUndefined();
    expect(result.sort).toBeUndefined();
  });

  it('respects custom defaultLimit and maxLimit', () => {
    expect(parse({}, { defaultLimit: 50 }).limit).toBe(50);
    expect(parse({ limit: '5000' }, { maxLimit: 100 }).limit).toBe(100);
  });

  it('page is a positive integer; anything else is refused, never defaulted', () => {
    expect(parse({ page: '3' }).page).toBe(3);
    expect(parse({}).page).toBeUndefined();
    expect(() => parse({ page: '0' })).toThrow(QueryGrammarError);
    expect(() => parse({ page: 'abc' })).toThrow(QueryGrammarError);
  });

  it('after cursor passes through opaquely', () => {
    expect(parse({ after: 'eyJ2Ij...' }).after).toBe('eyJ2Ij...');
  });

  it('search longer than maxSearchLength is refused, never truncated', () => {
    expect(() => parse({ search: 'x'.repeat(500) })).toThrow(QueryGrammarError);
    expect(parse({ search: 'x'.repeat(200) }).search?.length).toBe(200);
  });
});

describe('parseUrl — sort and select', () => {
  it('sort string "-createdAt,+name" → {createdAt:-1, name:1}', () => {
    expect(parse({ sort: '-createdAt,+name' }).sort).toEqual({ createdAt: -1, name: 1 });
  });

  it('sort outside allowedSortFields is refused', () => {
    expect(parse({ sort: '-createdAt' }, { allowedSortFields: ['createdAt'] }).sort).toEqual({
      createdAt: -1,
    });
    expect(() =>
      parse({ sort: '-createdAt,-secret' }, { allowedSortFields: ['createdAt'] }),
    ).toThrow(QueryGrammarError);
  });

  it('select "name,-password" → {name:1, password:0}', () => {
    expect(parse({ select: 'name,-password' }).select).toEqual({ name: 1, password: 0 });
  });
});

describe('parseUrl — filters (bracket syntax)', () => {
  it('field=value → eq', () => {
    const { filter } = parse({ status: 'active' });
    expect(filter).toMatchObject({ op: 'eq', field: 'status', value: 'active' });
  });

  it('field[gte]=18 → gte', () => {
    const { filter } = parse({ 'age[gte]': '18' }, { fieldTypes: { age: 'number' } });
    expect(filter).toMatchObject({ op: 'gte', field: 'age', value: 18 });
  });

  it('field[in]=a,b,c → in_', () => {
    const { filter } = parse({ 'role[in]': 'admin,editor,viewer' });
    expect(filter).toMatchObject({
      op: 'in',
      field: 'role',
      values: ['admin', 'editor', 'viewer'],
    });
  });

  it('multiple predicates on same field → AND combined', () => {
    const { filter } = parse(
      { 'age[gte]': '18', 'age[lt]': '65' },
      { fieldTypes: { age: 'number' } },
    );
    // and(gte, lt) — order within the and can vary; assert structure.
    expect(filter.op).toBe('and');
    if (filter.op === 'and') {
      const ops = filter.children.map((c) => c.op).sort();
      expect(ops).toEqual(['gte', 'lt']);
    }
  });

  it('field[between]=10,100 → between via and(gte, lte)', () => {
    const { filter } = parse({ 'price[between]': '10,100' }, { fieldTypes: { price: 'number' } });
    // `between` is sugar for and(gte, lte) — assert the resulting AND tree.
    expect(filter.op).toBe('and');
    if (filter.op === 'and') {
      const ops = filter.children.map((c) => c.op).sort();
      expect(ops).toEqual(['gte', 'lte']);
    }
  });

  it('field[contains]=john → substring LIKE', () => {
    const { filter } = parse({ 'name[contains]': 'john' });
    expect(filter).toMatchObject({
      op: 'like',
      field: 'name',
      pattern: '%john%',
      caseSensitivity: 'insensitive',
    });
  });

  it('field[exists]=false → isNull (i.e. exists false)', () => {
    const { filter } = parse({ 'deletedAt[exists]': 'false' });
    expect(filter).toEqual({ op: 'exists', field: 'deletedAt', exists: false });
  });

  // Dropping a filter WIDENS the read, so every allowlist refuses instead.
  it('a field outside allowedFilterFields is refused', () => {
    expect(() =>
      parse({ status: 'active', secret: 'leaked' }, { allowedFilterFields: ['status'] }),
    ).toThrow(QueryGrammarError);
  });

  it('an operator outside allowedOperators is refused', () => {
    expect(() => parse({ 'age[regex]': '.*' }, { allowedOperators: ['eq', 'gt'] })).toThrow(
      QueryGrammarError,
    );
  });

  it('a regex longer than maxRegexLength is refused', () => {
    expect(() => parse({ 'x[regex]': 'a'.repeat(1000) }, { maxRegexLength: 100 })).toThrow(
      QueryGrammarError,
    );
  });
});

describe('parseUrl — coercion', () => {
  it('ISO date string is coerced to a Date', () => {
    const { filter } = parse({ 'createdAt[gte]': '2026-01-01T00:00:00Z' });
    const f = filter as Filter & { op: 'gte' };
    expect(f.value).toBeInstanceOf(Date);
  });

  it('without a hint, only a safe number shape coerces — never a code or an id', () => {
    expect(parse({ qty: '12345' }).filter).toMatchObject({ value: 12345 });
    // Leading zeros are codes; past 15 digits it is an id (and loses precision as a number).
    expect(parse({ sku: '012345' }).filter).toMatchObject({ value: '012345' });
    expect(parse({ ref: '1234567890123456' }).filter).toMatchObject({ value: '1234567890123456' });
  });

  it('fieldTypes hint forces number coercion when declared', () => {
    const { filter } = parse({ age: '30' }, { fieldTypes: { age: 'number' } });
    expect(filter).toMatchObject({ op: 'eq', field: 'age', value: 30 });
  });

  it('fieldTypes "string" keeps numeric-looking values as string', () => {
    const { filter } = parse({ zip: '01234' }, { fieldTypes: { zip: 'string' } });
    expect(filter).toMatchObject({ op: 'eq', field: 'zip', value: '01234' });
  });
});

describe('parseUrl — populate grammar', () => {
  it('populate[author][select]=name,email → ParsedPopulate entry', () => {
    const { populate } = parse({
      'populate[author][select]': 'name email',
      'populate[author][match][active]': 'true',
    });
    expect(populate).toEqual([{ path: 'author', select: 'name email', match: { active: 'true' } }]);
  });
});

describe('parseUrl — reserved control params', () => {
  it('STANDARD_RESERVED_PARAMS holds pagination + dispatch verbs', () => {
    // Pagination + list control
    expect(STANDARD_RESERVED_PARAMS.has('page')).toBe(true);
    expect(STANDARD_RESERVED_PARAMS.has('limit')).toBe(true);
    expect(STANDARD_RESERVED_PARAMS.has('after')).toBe(true);
    expect(STANDARD_RESERVED_PARAMS.has('sort')).toBe(true);
    expect(STANDARD_RESERVED_PARAMS.has('select')).toBe(true);
    expect(STANDARD_RESERVED_PARAMS.has('populate')).toBe(true);
    expect(STANDARD_RESERVED_PARAMS.has('search')).toBe(true);
    // Dispatch verbs
    expect(STANDARD_RESERVED_PARAMS.has('_count')).toBe(true);
    expect(STANDARD_RESERVED_PARAMS.has('_distinct')).toBe(true);
    expect(STANDARD_RESERVED_PARAMS.has('_exists')).toBe(true);
    // Not reserved
    expect(STANDARD_RESERVED_PARAMS.has('status')).toBe(false);
    expect(STANDARD_RESERVED_PARAMS.has('_id')).toBe(false);
  });

  it('isControlParam matches the explicit allowlist only', () => {
    expect(isControlParam('page')).toBe(true);
    expect(isControlParam('search')).toBe(true);
    expect(isControlParam('_count')).toBe(true);
    expect(isControlParam('_distinct')).toBe(true);
    expect(isControlParam('_exists')).toBe(true);
    // Real filter fields — must NOT be treated as control params
    expect(isControlParam('status')).toBe(false);
    expect(isControlParam('_id')).toBe(false);
    expect(isControlParam('_v')).toBe(false);
    expect(isControlParam('_internal')).toBe(false);
    expect(isControlParam('_anything')).toBe(false);
    expect(isControlParam('')).toBe(false);
  });

  it('dispatch verbs never become filter predicates', () => {
    // `_count=true` + a real filter — only the real filter compiles.
    const result = parse({ _count: 'true', status: 'active' });
    expect(result.filter).toEqual({
      op: 'eq',
      field: 'status',
      value: 'active',
    } satisfies Filter);
  });

  it('preserves _id and other underscore-prefixed filter fields', () => {
    // Regression guard: a blanket `_*` rule would silently drop
    // these — Mongo's `_id` and any user-defined `_meta` field must
    // flow into the filter as eq predicates.
    const result = parse({ _id: '550e8400-e29b-41d4-a716-446655440000' });
    expect(result.filter).toEqual({
      op: 'eq',
      field: '_id',
      value: '550e8400-e29b-41d4-a716-446655440000',
    } satisfies Filter);
  });
});

describe('parseUrl — API stability across kits', () => {
  it('produces identical ParsedQuery shape regardless of input flavor', () => {
    // This test pins the integration contract with fluid / arc-next.
    const frontendEmitted = {
      status: 'active',
      'age[gte]': '18',
      sort: '-createdAt',
      page: '2',
      limit: '25',
      search: 'alice',
    };
    const r1 = parse(frontendEmitted, { fieldTypes: { age: 'number' } });
    const r2 = parseUrl(
      new URLSearchParams([
        ['status', 'active'],
        ['age[gte]', '18'],
        ['sort', '-createdAt'],
        ['page', '2'],
        ['limit', '25'],
        ['search', 'alice'],
      ]),
      { fieldTypes: { age: 'number' } },
    );
    expect(r1).toEqual(r2);
  });
});
