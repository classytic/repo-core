import { describe, expect, it } from 'vitest';
import type { Filter } from '../../../src/filter/index.js';
import { parseUrl } from '../../../src/query-parser/index.js';

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

  it('page is a positive integer or undefined', () => {
    expect(parse({ page: '3' }).page).toBe(3);
    expect(parse({ page: '0' }).page).toBeUndefined();
    expect(parse({ page: 'abc' }).page).toBeUndefined();
  });

  it('after cursor passes through opaquely', () => {
    expect(parse({ after: 'eyJ2Ij...' }).after).toBe('eyJ2Ij...');
  });

  it('search is capped at maxSearchLength', () => {
    const long = 'x'.repeat(500);
    expect(parse({ search: long }).search?.length).toBe(200);
  });
});

describe('parseUrl — sort and select', () => {
  it('sort string "-createdAt,+name" → {createdAt:-1, name:1}', () => {
    expect(parse({ sort: '-createdAt,+name' }).sort).toEqual({ createdAt: -1, name: 1 });
  });

  it('sort respects allowedSortFields allowlist', () => {
    expect(
      parse({ sort: '-createdAt,-secret' }, { allowedSortFields: ['createdAt'] }).sort,
    ).toEqual({ createdAt: -1 });
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

  it('allowedFilterFields allowlist drops unknown fields', () => {
    const { filter } = parse(
      { status: 'active', secret: 'leaked' },
      { allowedFilterFields: ['status'] },
    );
    // Only `status` made it in — `secret` was dropped.
    expect(filter).toMatchObject({ op: 'eq', field: 'status', value: 'active' });
  });

  it('allowedOperators closes the operator set', () => {
    const { filter } = parse({ 'age[regex]': '.*' }, { allowedOperators: ['eq', 'gt'] });
    expect(filter).toEqual({ op: 'true' }); // regex was dropped
  });

  it('regex pattern length is capped', () => {
    const longPattern = 'a'.repeat(1000);
    const { filter } = parse({ 'x[regex]': longPattern }, { maxRegexLength: 100 });
    expect(filter).toEqual({ op: 'true' });
  });
});

describe('parseUrl — coercion', () => {
  it('ISO date string is coerced to a Date', () => {
    const { filter } = parse({ 'createdAt[gte]': '2026-01-01T00:00:00Z' });
    const f = filter as Filter & { op: 'gte' };
    expect(f.value).toBeInstanceOf(Date);
  });

  it('conservative heuristic does NOT coerce numeric-looking strings without a hint', () => {
    // Classic footgun: SKU "12345" must stay a string, not become a number.
    const { filter } = parse({ sku: '12345' });
    expect(filter).toMatchObject({ op: 'eq', field: 'sku', value: '12345' });
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
