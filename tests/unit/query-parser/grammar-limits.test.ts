import { describe, expect, it } from 'vitest';
import {
  QueryGrammarError,
  readFilterClauses,
  readSelect,
  readSort,
} from '../../../src/query-parser/index.js';

describe('query grammar — limits and refinements', () => {
  it('refuses input nested past the depth cap before recursing (no stack overflow)', () => {
    let deep: Record<string, unknown> = { leaf: '1' };
    for (let i = 0; i < 10_000; i++) deep = { n: deep };
    expect(() => readFilterClauses({ a: deep })).toThrow(QueryGrammarError);
  });

  it('gates only an explicit operator against allowedOperators — `field=value` is not one', () => {
    const { clauses } = readFilterClauses({ status: 'active' }, { allowedOperators: ['in'] });
    expect(clauses).toEqual([{ field: 'status', op: 'eq', value: 'active' }]);
    expect(() =>
      readFilterClauses({ 'status[eq]': 'active' }, { allowedOperators: ['in'] }),
    ).toThrow(QueryGrammarError);
  });

  it('a range bound of any length is a number; equality keeps a long digit string', () => {
    const { clauses } = readFilterClauses({
      'age[lte]': '9007199254740991',
      ref: '9007199254740991',
    });
    expect(clauses).toEqual([
      { field: 'age', op: 'lte', value: 9007199254740991 },
      { field: 'ref', op: 'eq', value: '9007199254740991' },
    ]);
  });

  it('accepts hyphenated field names', () => {
    expect(readFilterClauses({ 'field-with-dashes': 'x' }).clauses).toEqual([
      { field: 'field-with-dashes', op: 'eq', value: 'x' },
    ]);
  });

  it('drop mode skips only the refused sort token', () => {
    const dropped: string[] = [];
    const sort = readSort('-createdAt,secret', {
      allowedSortFields: ['createdAt'],
      onInvalid: (e) => dropped.push(e.meta.reason),
    });
    expect(sort).toEqual({ createdAt: -1 });
    expect(dropped).toHaveLength(1);
  });

  it('select accepts a validated projection object', () => {
    expect(readSelect({ name: 1, password: '0' })).toEqual({ name: 1, password: 0 });
    expect(() => readSelect({ $where: 1 })).toThrow(QueryGrammarError);
    expect(() => readSelect({ name: 2 })).toThrow(QueryGrammarError);
  });
});

describe('query grammar — drop mode reaches structural refusals too', () => {
  it('a too-deep entry is dropped in drop mode, not thrown', () => {
    let deep: Record<string, unknown> = { leaf: '1' };
    for (let i = 0; i < 10_000; i++) deep = { n: deep };
    const refused: string[] = [];
    const { clauses } = readFilterClauses(
      { a: deep, status: 'active' },
      { onInvalid: (e) => refused.push(e.meta.reason) },
    );
    expect(refused).toEqual(['nested too deeply']);
    expect(clauses).toEqual([{ field: 'status', op: 'eq', value: 'active' }]);
  });
});

describe('query grammar — refusals carry their kind', () => {
  const kindOf = (input: Record<string, unknown>, options = {}) => {
    try {
      readFilterClauses(input, options);
    } catch (error) {
      return (error as QueryGrammarError).meta.kind;
    }
    return undefined;
  };

  it('classifies smuggling and malformed keys as syntax', () => {
    expect(kindOf({ $where: '1' })).toBe('syntax');
    expect(kindOf({ 'status[$ne]': 'x' })).toBe('syntax');
    expect(kindOf({ 'meta[color]': 'red' })).toBe('syntax');
  });

  it('classifies allowlist misses as policy and bad values as value', () => {
    expect(kindOf({ secret: 'x' }, { allowedFilterFields: ['status'] })).toBe('policy');
    expect(kindOf({ 'qty[gte]': 'null' })).toBe('value');
  });
});

describe('query grammar — sort and select separators', () => {
  it("accepts Mongoose's space-separated form as well as commas", () => {
    expect(readSelect('name createdAt -password')).toEqual({ name: 1, createdAt: 1, password: 0 });
    expect(readSort('-createdAt name')).toEqual({ createdAt: -1, name: 1 });
    expect(readSort('-createdAt, name')).toEqual({ createdAt: -1, name: 1 });
  });
});
