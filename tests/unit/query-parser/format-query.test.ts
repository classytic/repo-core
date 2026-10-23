import { describe, expect, it } from 'vitest';
import {
  and,
  contains,
  endsWith,
  eq,
  exists,
  gt,
  gte,
  iEq,
  in_,
  lt,
  lte,
  ne,
  nin,
  regex,
  startsWith,
} from '../../../src/filter/index.js';
import {
  type FilterTerm,
  formatQuery,
  parseUrl,
  QueryGrammarError,
  stringifyQuery,
  URL_OPERATORS,
} from '../../../src/query-parser/index.js';

describe('formatQuery round-trips through parseUrl', () => {
  const cases: [string, FilterTerm, unknown][] = [
    ['eq', { field: 'status', value: 'active' }, eq('status', 'active')],
    ['ne', { field: 'status', op: 'ne', value: 'x' }, ne('status', 'x')],
    ['gt', { field: 'n', op: 'gt', value: 5 }, gt('n', 5)],
    ['gte', { field: 'n', op: 'gte', value: 5 }, gte('n', 5)],
    ['lt', { field: 'n', op: 'lt', value: 5 }, lt('n', 5)],
    ['lte', { field: 'n', op: 'lte', value: 5 }, lte('n', 5)],
    ['in', { field: 'r', op: 'in', value: ['a', 'b'] }, in_('r', ['a', 'b'])],
    ['nin', { field: 'r', op: 'nin', value: ['a'] }, nin('r', ['a'])],
    ['exists', { field: 'd', op: 'exists', value: false }, exists('d', false)],
    ['contains', { field: 'name', op: 'contains', value: 'jo&n' }, contains('name', 'jo&n')],
    ['like', { field: 'name', op: 'like', value: 'jo' }, contains('name', 'jo')],
    ['startsWith', { field: 'name', op: 'startsWith', value: 'j' }, startsWith('name', 'j')],
    ['endsWith', { field: 'name', op: 'endsWith', value: 'n' }, endsWith('name', 'n')],
    ['ieq', { field: 'name', op: 'ieq', value: 'JO' }, iEq('name', 'JO')],
    ['regex', { field: 'name', op: 'regex', value: '^a', flags: 'i' }, regex('name', '^a', 'i')],
    ['between', { field: 'n', op: 'between', value: [1, 9] }, and(gte('n', 1), lte('n', 9))],
  ];

  it('covers every URL operator', () => {
    const covered = new Set(cases.map(([name]) => name));
    for (const op of URL_OPERATORS) {
      if (op !== 'options') expect(covered.has(op)).toBe(true);
    }
  });

  it.each(cases)('%s', (_name, term, expected) => {
    expect(parseUrl(formatQuery({ filters: [term] })).filter).toEqual(expected);
  });

  it('sends Dates as ISO and between as gte + lte', () => {
    const from = new Date('2026-01-01T00:00:00.000Z');
    const to = new Date('2026-01-31T00:00:00.000Z');
    const params = formatQuery({ filters: [{ field: 'at', op: 'between', value: [from, to] }] });
    expect(params).toEqual({ 'at[gte]': from.toISOString(), 'at[lte]': to.toISOString() });
    expect(parseUrl(params).filter).toEqual(and(gte('at', from), lte('at', to)));
  });

  it('an open side of between sends one bound', () => {
    const params = formatQuery({ filters: [{ field: 'n', op: 'between', value: [1, ''] }] });
    expect(params).toEqual({ 'n[gte]': '1' });
  });

  it('control params round-trip', () => {
    const q = parseUrl(
      formatQuery({ sort: ['-createdAt', 'name'], page: 2, limit: 50, search: ' jo ' }),
    );
    expect(q.sort).toEqual({ createdAt: -1, name: 1 });
    expect([q.page, q.limit, q.search]).toEqual([2, 50, 'jo']);
  });

  it('stringifyQuery output parses back', () => {
    const qs = stringifyQuery({ filters: [{ field: 'n', op: 'gte', value: 3 }] });
    expect(qs).toBe('n%5Bgte%5D=3');
    expect(parseUrl(new URLSearchParams(qs)).filter).toEqual(gte('n', 3));
  });

  it('empty values are no filter', () => {
    const filters: FilterTerm[] = [
      { field: 'a', value: '' },
      { field: 'b', op: 'in', value: [] },
      { field: 'c' },
    ];
    expect(formatQuery({ filters })).toEqual({});
  });

  it('refuses what the grammar cannot carry', () => {
    const bad: FilterTerm[] = [
      { field: 'a b', value: 1 },
      { field: 'a', op: 'in', value: ['x,y'] },
      { field: 'a', op: 'in', value: 'x' },
      { field: 'a', value: 'null' },
      { field: 'a', op: 'exists', value: 'yes' },
      { field: 'a', op: 'options' as never, value: 'i' },
      { field: 'a', value: Number.NaN },
    ];
    for (const term of bad) {
      expect(() => formatQuery({ filters: [term] })).toThrow(QueryGrammarError);
    }
    const twice: FilterTerm[] = [
      { field: 'a', value: 1 },
      { field: 'a', value: 2 },
    ];
    expect(() => formatQuery({ filters: twice })).toThrow(QueryGrammarError);
    expect(() => formatQuery({ page: 0 })).toThrow(QueryGrammarError);
  });
});
