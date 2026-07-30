import { describe, expect, it } from 'vitest';
import {
  coerceFilterDates,
  ISO_DATE_PATTERN,
  tryCoerceIsoDate,
} from '../../../src/filter/coerce-dates.js';

describe('tryCoerceIsoDate', () => {
  it('coerces unambiguous ISO-8601 forms', () => {
    for (const iso of [
      '2026-04-19',
      '2026-04-19T10:00',
      '2026-04-19T10:00:00',
      '2026-04-19T10:00:00.123',
      '2026-04-19T10:00:00Z',
      '2026-04-19T10:00:00+06:00',
      '2026-04-19T10:00:00+0600',
    ]) {
      expect(tryCoerceIsoDate(iso), iso).toBeInstanceOf(Date);
    }
  });

  it('leaves date-SHAPED but non-date strings alone (anchored pattern)', () => {
    // The whole reason the pattern is anchored at both ends: a prefix-only
    // match would rewrite these legitimate string ids into Dates.
    for (const notADate of [
      '2026-04-19-ORDER-123',
      '2026-04-19_backup',
      '2026-04-19/invoice',
      'ORD-2026-04-19',
    ]) {
      expect(tryCoerceIsoDate(notADate), notADate).toBe(notADate);
    }
  });

  it('leaves non-strings and unparseable dates alone', () => {
    const date = new Date();
    expect(tryCoerceIsoDate(date)).toBe(date);
    expect(tryCoerceIsoDate(42)).toBe(42);
    expect(tryCoerceIsoDate(null)).toBeNull();
    expect(tryCoerceIsoDate(undefined)).toBeUndefined();
    // Shape-valid but not a real calendar date.
    expect(tryCoerceIsoDate('2026-13-45')).toBe('2026-13-45');
  });

  it('exposes the pattern so kits share ONE definition of "looks like a date"', () => {
    expect(ISO_DATE_PATTERN.test('2026-04-19')).toBe(true);
    expect(ISO_DATE_PATTERN.test('2026-04-19-ORDER-1')).toBe(false);
  });
});

describe('coerceFilterDates', () => {
  const iso = '2026-04-19T00:00:00.000Z';

  it('coerces $-prefixed range operators', () => {
    const out = coerceFilterDates({ createdAt: { $gte: iso, $lte: iso } });
    const range = out.createdAt as Record<string, unknown>;
    expect(range.$gte).toBeInstanceOf(Date);
    expect(range.$lte).toBeInstanceOf(Date);
  });

  it('coerces bare shorthand range operators', () => {
    const out = coerceFilterDates({ createdAt: { gte: iso } });
    expect((out.createdAt as Record<string, unknown>).gte).toBeInstanceOf(Date);
  });

  it('recurses $and / $or / $nor arrays — the policy-scope merge shape', () => {
    const out = coerceFilterDates({
      $and: [{ organizationId: 'org-1' }, { createdAt: { $gte: iso } }],
    });
    const [, second] = out.$and as Record<string, unknown>[];
    expect((second?.createdAt as Record<string, unknown>).$gte).toBeInstanceOf(Date);
  });

  it('recurses nested logical wrappers', () => {
    const out = coerceFilterDates({
      $or: [{ $and: [{ createdAt: { $lt: iso } }] }],
    });
    const outer = (out.$or as Record<string, unknown>[])[0];
    const inner = (outer?.$and as Record<string, unknown>[])[0];
    expect((inner?.createdAt as Record<string, unknown>).$lt).toBeInstanceOf(Date);
  });

  it('recurses $not (single-object logical operator)', () => {
    const out = coerceFilterDates({ $not: { createdAt: { $gte: iso } } });
    const inner = out.$not as Record<string, unknown>;
    expect((inner.createdAt as Record<string, unknown>).$gte).toBeInstanceOf(Date);
  });

  it('does NOT coerce equality — a date-looking eq is usually a string id', () => {
    const out = coerceFilterDates({ ref: { $eq: '2026-04-19' } });
    expect((out.ref as Record<string, unknown>).$eq).toBe('2026-04-19');
  });

  it('leaves real nested documents and non-range operators untouched', () => {
    const input = {
      address: { city: 'Dhaka' },
      tags: { $in: ['a', 'b'] },
      status: 'active',
    };
    expect(coerceFilterDates(input)).toEqual(input);
  });

  it('never mutates the input', () => {
    const input = { createdAt: { $gte: iso } };
    const out = coerceFilterDates(input);
    expect(input.createdAt.$gte).toBe(iso);
    expect(out).not.toBe(input);
  });

  it('returns the SAME nested object when nothing changed (no needless copies)', () => {
    const input = { tags: { $in: ['a'] } };
    expect(coerceFilterDates(input).tags).toBe(input.tags);
  });

  it('handles an empty filter', () => {
    expect(coerceFilterDates({})).toEqual({});
  });

  it('preserves already-typed Date bounds', () => {
    const when = new Date(iso);
    const out = coerceFilterDates({ createdAt: { $gte: when } });
    expect((out.createdAt as Record<string, unknown>).$gte).toBe(when);
  });
});
