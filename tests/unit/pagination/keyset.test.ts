import { describe, expect, it } from 'vitest';
import {
  getPrimaryField,
  invertSort,
  normalizeSort,
  validateKeysetSort,
} from '../../../src/pagination/index.js';

describe('normalizeSort', () => {
  it('puts non-_id fields first, _id last', () => {
    const normalized = normalizeSort({ _id: -1, createdAt: -1 });
    expect(Object.keys(normalized)).toEqual(['createdAt', '_id']);
  });

  it('is identity when already normalized', () => {
    const sort = { createdAt: -1, _id: -1 } as const;
    expect(normalizeSort(sort)).toEqual(sort);
  });
});

describe('validateKeysetSort', () => {
  it('accepts single _id sort as-is', () => {
    expect(validateKeysetSort({ _id: -1 })).toEqual({ _id: -1 });
  });

  it('auto-adds _id tie-breaker matching the primary direction', () => {
    expect(validateKeysetSort({ createdAt: -1 })).toEqual({ createdAt: -1, _id: -1 });
    expect(validateKeysetSort({ createdAt: 1 })).toEqual({ createdAt: 1, _id: 1 });
  });

  it('rejects empty sort', () => {
    expect(() => validateKeysetSort({})).toThrow(/at least one sort field/);
  });

  it('rejects non-±1 directions', () => {
    expect(() => validateKeysetSort({ x: 0 as never })).toThrow(/must be 1 or -1/);
  });

  it('rejects mixed directions across fields', () => {
    expect(() => validateKeysetSort({ a: 1, b: -1 })).toThrow(
      /same direction for keyset pagination/,
    );
  });

  it('rejects _id direction that contradicts primary direction', () => {
    expect(() => validateKeysetSort({ createdAt: -1, _id: 1 })).toThrow(/_id direction must match/);
  });

  it('honors allowedPrimaryFields allowlist', () => {
    expect(() => validateKeysetSort({ createdAt: -1 }, ['createdAt'])).not.toThrow();
    expect(() => validateKeysetSort({ priority: -1 }, ['createdAt'])).toThrow(
      /not in the strictKeysetSortFields/,
    );
  });

  it('empty allowlist disables the gate', () => {
    expect(() => validateKeysetSort({ anyField: -1 }, [])).not.toThrow();
  });
});

describe('invertSort', () => {
  it('flips 1 to -1 and vice versa', () => {
    expect(invertSort({ a: 1, b: -1 })).toEqual({ a: -1, b: 1 });
  });

  it('preserves structural key order', () => {
    const result = invertSort({ a: 1, b: 1, c: 1 });
    expect(Object.keys(result)).toEqual(['a', 'b', 'c']);
  });
});

describe('getPrimaryField', () => {
  it('returns the first non-_id key', () => {
    expect(getPrimaryField({ createdAt: -1, _id: -1 })).toBe('createdAt');
  });

  it('falls back to _id when that is the only key', () => {
    expect(getPrimaryField({ _id: -1 })).toBe('_id');
  });

  it('falls back to _id when sort is empty', () => {
    expect(getPrimaryField({})).toBe('_id');
  });
});
