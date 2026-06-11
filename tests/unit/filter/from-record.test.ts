/**
 * `recordToFilter` — the canonical record → Filter IR normalizer
 * (promoted from per-kit copies in 0.6.0). Pins the mapping table so
 * kits that delete their local copies inherit identical semantics.
 */

import { describe, expect, it } from 'vitest';
import { and, eq, gte, isNotNull, isNull, lt } from '../../../src/filter/builders.js';
import { recordToFilter } from '../../../src/filter/from-record.js';

describe('recordToFilter', () => {
  it('maps a flat record to eq leaves ANDed together', () => {
    expect(recordToFilter({ status: 'active' })).toEqual(eq('status', 'active'));
    expect(recordToFilter({ active: true, role: 'admin' })).toEqual(
      and(eq('active', true), eq('role', 'admin')),
    );
  });

  it('maps operator objects to range/membership leaves', () => {
    expect(recordToFilter({ price: { gte: 100, lt: 1000 } })).toEqual(
      and(gte('price', 100), lt('price', 1000)),
    );
    expect(recordToFilter({ tags: { in: ['a', 'b'] } })).toEqual({
      op: 'in',
      field: 'tags',
      values: ['a', 'b'],
    });
  });

  it('treats null as isNull and bare arrays as in_', () => {
    expect(recordToFilter({ deletedAt: null })).toEqual(isNull('deletedAt'));
    expect(recordToFilter({ status: ['a', 'b'] })).toEqual({
      op: 'in',
      field: 'status',
      values: ['a', 'b'],
    });
  });

  it('passes Filter IR inputs through unchanged', () => {
    const ir = and(eq('a', 1), gte('b', 2));
    expect(recordToFilter(ir)).toBe(ir);
  });

  it('returns TRUE for empty records and skips undefined values', () => {
    expect(recordToFilter({})).toEqual({ op: 'true' });
    expect(recordToFilter({ a: undefined as unknown as string })).toEqual({ op: 'true' });
  });

  it('treats exists:true/false as isNotNull/isNull', () => {
    expect(recordToFilter({ email: { exists: true } })).toEqual(isNotNull('email'));
    expect(recordToFilter({ email: { exists: false } })).toEqual(isNull('email'));
  });
});
