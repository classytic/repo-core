/**
 * Unit tests for `nestDottedKeys` — the cross-kit AggResult row
 * normalizer.
 */

import { describe, expect, it } from 'vitest';
import { nestDottedKeys, nestDottedKeysAll } from '../../../src/repository/agg-output.js';

describe('nestDottedKeys', () => {
  it('passes plain rows through unchanged', () => {
    expect(nestDottedKeys({ status: 'pending', count: 3 })).toEqual({
      status: 'pending',
      count: 3,
    });
  });

  it('nests a single dotted-path key', () => {
    expect(nestDottedKeys({ 'department.code': 'ENG', count: 3 })).toEqual({
      department: { code: 'ENG' },
      count: 3,
    });
  });

  it('mixes flat + nested in one row', () => {
    expect(
      nestDottedKeys({
        status: 'pending',
        'department.code': 'ENG',
        'department.name': 'Engineering',
        count: 3,
      }),
    ).toEqual({
      status: 'pending',
      department: { code: 'ENG', name: 'Engineering' },
      count: 3,
    });
  });

  it('handles multi-level paths via recursive descent', () => {
    expect(nestDottedKeys({ 'a.b.c': 1, 'a.b.d': 2, 'a.e': 3 })).toEqual({
      a: { b: { c: 1, d: 2 }, e: 3 },
    });
  });

  it('preserves null + falsy values', () => {
    expect(
      nestDottedKeys({
        'department.code': null,
        'department.empty': '',
        zero: 0,
      }),
    ).toEqual({
      department: { code: null, empty: '' },
      zero: 0,
    });
  });

  it('does not mutate the input', () => {
    const input = { 'department.code': 'ENG', count: 3 };
    const snapshot = JSON.stringify(input);
    nestDottedKeys(input);
    expect(JSON.stringify(input)).toBe(snapshot);
  });

  it('handles empty rows', () => {
    expect(nestDottedKeys({})).toEqual({});
  });

  it('nestDottedKeysAll maps an array of rows', () => {
    const result = nestDottedKeysAll([
      { 'department.code': 'ENG', count: 3 },
      { 'department.code': 'SAL', count: 2 },
    ]);
    expect(result).toEqual([
      { department: { code: 'ENG' }, count: 3 },
      { department: { code: 'SAL' }, count: 2 },
    ]);
  });
});
