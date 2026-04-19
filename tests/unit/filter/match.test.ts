import { describe, expect, it } from 'vitest';
import {
  and,
  asPredicate,
  eq,
  exists,
  gt,
  gte,
  in_,
  like,
  lt,
  matchFilter,
  ne,
  nin,
  not,
  or,
  regex,
} from '../../../src/filter/index.js';

describe('matchFilter leaf ops', () => {
  const doc = { name: 'Alice', age: 30, role: 'admin', deletedAt: null };

  it('eq — equality via SameValueZero', () => {
    expect(matchFilter(doc, eq('name', 'Alice'))).toBe(true);
    expect(matchFilter(doc, eq('name', 'alice'))).toBe(false);
  });

  it('ne — inverts eq', () => {
    expect(matchFilter(doc, ne('name', 'Bob'))).toBe(true);
    expect(matchFilter(doc, ne('name', 'Alice'))).toBe(false);
  });

  it('gt / gte / lt / lte — numeric comparisons', () => {
    expect(matchFilter(doc, gt('age', 29))).toBe(true);
    expect(matchFilter(doc, gt('age', 30))).toBe(false);
    expect(matchFilter(doc, gte('age', 30))).toBe(true);
    expect(matchFilter(doc, lt('age', 31))).toBe(true);
  });

  it('in / nin — membership', () => {
    expect(matchFilter(doc, in_('role', ['admin', 'editor']))).toBe(true);
    expect(matchFilter(doc, in_('role', ['reader']))).toBe(false);
    expect(matchFilter(doc, nin('role', ['reader', 'viewer']))).toBe(true);
  });

  it('exists — present and absent distinctions', () => {
    expect(matchFilter(doc, exists('name'))).toBe(true);
    expect(matchFilter(doc, exists('missing'))).toBe(false);
    // Soft-delete pattern: "deletedAt is null" must count as "not present".
    expect(matchFilter(doc, exists('deletedAt', false))).toBe(true);
  });

  it('like — SQL wildcards % and _ map to regex', () => {
    expect(matchFilter(doc, like('name', 'Al%'))).toBe(true);
    expect(matchFilter(doc, like('name', '_lice'))).toBe(true);
    expect(matchFilter(doc, like('name', 'Bob%'))).toBe(false);
  });

  it('like — case-insensitive by default, sensitive opt-in', () => {
    expect(matchFilter(doc, like('name', 'ALICE'))).toBe(true);
    expect(matchFilter(doc, like('name', 'ALICE', 'sensitive'))).toBe(false);
  });

  it('regex — JS dialect', () => {
    expect(matchFilter(doc, regex('name', '^A'))).toBe(true);
    expect(matchFilter(doc, regex('name', 'alice', 'i'))).toBe(true);
  });
});

describe('matchFilter Date handling', () => {
  const createdAt = new Date('2026-01-01T00:00:00.000Z');
  const doc = { createdAt };

  it('Date instances compare by getTime', () => {
    expect(matchFilter(doc, eq('createdAt', new Date('2026-01-01T00:00:00.000Z')))).toBe(true);
    expect(matchFilter(doc, lt('createdAt', new Date('2026-02-01T00:00:00.000Z')))).toBe(true);
  });

  it('Date-vs-ISO-string equality works — handles JSON roundtrip', () => {
    expect(matchFilter(doc, eq('createdAt', '2026-01-01T00:00:00.000Z'))).toBe(true);
  });
});

describe('matchFilter nested fields', () => {
  const doc = { user: { profile: { email: 'a@b.com' } } };

  it('dot notation resolves nested paths', () => {
    expect(matchFilter(doc, eq('user.profile.email', 'a@b.com'))).toBe(true);
  });

  it('missing path segment evaluates to undefined (fails eq, passes exists:false)', () => {
    expect(matchFilter(doc, eq('user.profile.phone', '123'))).toBe(false);
    expect(matchFilter(doc, exists('user.profile.phone', false))).toBe(true);
  });
});

describe('matchFilter boolean composition', () => {
  const doc = { status: 'active', count: 5 };

  it('and — all children must match', () => {
    expect(matchFilter(doc, and(eq('status', 'active'), gt('count', 0)))).toBe(true);
    expect(matchFilter(doc, and(eq('status', 'active'), gt('count', 100)))).toBe(false);
  });

  it('or — any child matches', () => {
    expect(matchFilter(doc, or(eq('status', 'pending'), gt('count', 0)))).toBe(true);
    expect(matchFilter(doc, or(eq('status', 'pending'), lt('count', 0)))).toBe(false);
  });

  it('not — negates', () => {
    expect(matchFilter(doc, not(eq('status', 'pending')))).toBe(true);
    expect(matchFilter(doc, not(eq('status', 'active')))).toBe(false);
  });
});

describe('asPredicate', () => {
  it('produces a closure usable with Array.filter', () => {
    const items = [
      { role: 'admin', active: true },
      { role: 'reader', active: true },
      { role: 'admin', active: false },
    ];
    const isActiveAdmin = asPredicate<(typeof items)[number]>(
      and(eq('role', 'admin'), eq('active', true)),
    );
    expect(items.filter(isActiveAdmin)).toEqual([{ role: 'admin', active: true }]);
  });
});

describe('multi-tenant scope injection (end-to-end plugin scenario)', () => {
  it('injected tenant filter successfully excludes other tenants', () => {
    const userQuery = eq('status', 'active');
    const withTenant = and(eq('orgId', 'org_42'), userQuery);

    const docs = [
      { orgId: 'org_42', status: 'active' },
      { orgId: 'org_42', status: 'pending' },
      { orgId: 'org_99', status: 'active' },
    ];
    expect(docs.filter(asPredicate(withTenant))).toEqual([{ orgId: 'org_42', status: 'active' }]);
  });
});
