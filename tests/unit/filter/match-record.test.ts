/**
 * `matchesRecordFilter` / `policyRecordToFilter` — the canonical in-memory
 * evaluator for arc's Mongo-record `_policyFilters` (THE
 * `DataAdapter.matchesFilter` implementation every kit delegates to).
 *
 * Pure; no DB. Split into: core contract, full operator surface, Mongo
 * array/dot-path semantics, id/type coercion, edge + adversarial cases
 * (prototype pollution, NaN, deep nesting, empty inputs), and a
 * performance/efficiency smoke to keep the hot path linear + cached.
 */

import { describe, expect, it } from 'vitest';
import { matchesRecordFilter, policyRecordToFilter } from '../../../src/filter/match-record.js';

// ── Core contract ──────────────────────────────────────────────────────────

describe('matchesRecordFilter — core contract', () => {
  it('implicit equality; field AND', () => {
    expect(matchesRecordFilter({ ownerId: 'u1', n: 1 }, { ownerId: 'u1' })).toBe(true);
    expect(matchesRecordFilter({ ownerId: 'u2' }, { ownerId: 'u1' })).toBe(false);
    expect(matchesRecordFilter({ a: 1, b: 2 }, { a: 1, b: 2 })).toBe(true);
    expect(matchesRecordFilter({ a: 1, b: 3 }, { a: 1, b: 2 })).toBe(false);
  });

  it('empty filter matches; non-objects never match', () => {
    expect(matchesRecordFilter({ a: 1 }, {})).toBe(true);
    expect(matchesRecordFilter(null, { a: 1 })).toBe(false);
    expect(matchesRecordFilter(undefined, { a: 1 })).toBe(false);
    expect(matchesRecordFilter('x', { a: 1 })).toBe(false);
    expect(matchesRecordFilter(42, { a: 1 })).toBe(false);
  });

  it('{ field: null } is a null check', () => {
    expect(matchesRecordFilter({ deletedAt: null }, { deletedAt: null })).toBe(true);
    expect(matchesRecordFilter({ deletedAt: new Date() }, { deletedAt: null })).toBe(false);
    expect(matchesRecordFilter({ other: 1 }, { deletedAt: null })).toBe(true); // missing ≈ null
  });

  it('logical: $or / $and / $nor / $not', () => {
    const grant = { $or: [{ ownerId: 'u1' }, { _id: { $in: ['d1'] } }] };
    expect(matchesRecordFilter({ _id: 'd1', ownerId: 'x' }, grant)).toBe(true);
    expect(matchesRecordFilter({ _id: 'x', ownerId: 'u1' }, grant)).toBe(true);
    expect(matchesRecordFilter({ _id: 'x', ownerId: 'x' }, grant)).toBe(false);
    expect(matchesRecordFilter({ a: 1, b: 2 }, { $and: [{ a: 1 }, { b: 2 }] })).toBe(true);
    expect(matchesRecordFilter({ a: 2 }, { $nor: [{ a: 2 }, { a: 3 }] })).toBe(false);
    expect(matchesRecordFilter({ a: 1 }, { $nor: [{ a: 2 }] })).toBe(true);
    expect(matchesRecordFilter({ a: 1 }, { $not: { a: 2 } })).toBe(true);
    expect(matchesRecordFilter({ a: 2 }, { $not: { a: 2 } })).toBe(false);
  });

  it('deeply nested logical composition', () => {
    const f = {
      $and: [{ $or: [{ a: 1 }, { a: 2 }] }, { $nor: [{ b: 9 }] }, { $not: { c: 0 } }],
    };
    expect(matchesRecordFilter({ a: 2, b: 1, c: 5 }, f)).toBe(true);
    expect(matchesRecordFilter({ a: 3, b: 1, c: 5 }, f)).toBe(false); // fails $or
    expect(matchesRecordFilter({ a: 2, b: 9, c: 5 }, f)).toBe(false); // fails $nor
    expect(matchesRecordFilter({ a: 2, b: 1, c: 0 }, f)).toBe(false); // fails $not
  });
});

// ── Full operator surface ────────────────────────────────────────────────

describe('matchesRecordFilter — comparison / membership / existence / regex', () => {
  it('$eq / $ne (incl. null → is/isNot null)', () => {
    expect(matchesRecordFilter({ a: 1 }, { a: { $eq: 1 } })).toBe(true);
    expect(matchesRecordFilter({ a: 1 }, { a: { $ne: 2 } })).toBe(true);
    expect(matchesRecordFilter({ a: 1 }, { a: { $ne: 1 } })).toBe(false);
    expect(matchesRecordFilter({ a: null }, { a: { $eq: null } })).toBe(true);
    expect(matchesRecordFilter({ a: 1 }, { a: { $ne: null } })).toBe(true);
  });

  it('$gt / $gte / $lt / $lte on numbers, dates, and ISO strings', () => {
    expect(matchesRecordFilter({ n: 5 }, { n: { $gte: 5, $lt: 10 } })).toBe(true);
    expect(matchesRecordFilter({ n: 10 }, { n: { $lt: 10 } })).toBe(false);
    const doc = { at: new Date('2026-07-16T12:00:00Z') };
    expect(matchesRecordFilter(doc, { at: { $gt: '2026-07-16T00:00:00Z' } })).toBe(true);
    expect(matchesRecordFilter({ s: '2026-07-16' }, { s: { $lte: '2026-07-17' } })).toBe(true);
  });

  it('$in / $nin', () => {
    expect(matchesRecordFilter({ _id: 'd1' }, { _id: { $in: ['d1', 'd2'] } })).toBe(true);
    expect(matchesRecordFilter({ _id: 'd9' }, { _id: { $in: ['d1', 'd2'] } })).toBe(false);
    expect(matchesRecordFilter({ _id: 'd1' }, { _id: { $in: [] } })).toBe(false);
    expect(matchesRecordFilter({ role: 'user' }, { role: { $nin: ['admin'] } })).toBe(true);
    expect(matchesRecordFilter({ role: 'admin' }, { role: { $nin: ['admin'] } })).toBe(false);
  });

  it('$exists means present-and-non-null (cross-dialect; SQL has no key-absence)', () => {
    expect(matchesRecordFilter({ a: 1 }, { a: { $exists: true } })).toBe(true);
    expect(matchesRecordFilter({ a: [] }, { a: { $exists: true } })).toBe(true);
    // null reads as "not present" (== SQL IS NULL, == the IR `exists` op).
    expect(matchesRecordFilter({ a: null }, { a: { $exists: true } })).toBe(false);
    expect(matchesRecordFilter({ a: null }, { a: { $exists: false } })).toBe(true);
    expect(matchesRecordFilter({ b: 1 }, { a: { $exists: true } })).toBe(false);
    expect(matchesRecordFilter({ b: 1 }, { a: { $exists: false } })).toBe(true);
  });

  it('$regex — string, $options, and RegExp literal', () => {
    expect(matchesRecordFilter({ name: 'Widget' }, { name: { $regex: '^Wid' } })).toBe(true);
    expect(
      matchesRecordFilter({ name: 'widget' }, { name: { $regex: '^WID', $options: 'i' } }),
    ).toBe(true);
    expect(matchesRecordFilter({ name: 'x' }, { name: { $regex: /^y/ } })).toBe(false);
    expect(matchesRecordFilter({ name: 42 }, { name: { $regex: '4' } })).toBe(false); // non-string
  });

  it('multiple operators on one field are ANDed', () => {
    expect(matchesRecordFilter({ n: 7 }, { n: { $gt: 5, $lt: 10, $ne: 8 } })).toBe(true);
    expect(matchesRecordFilter({ n: 8 }, { n: { $gt: 5, $lt: 10, $ne: 8 } })).toBe(false);
  });
});

// ── Mongo array + dot-path semantics ─────────────────────────────────────

describe('matchesRecordFilter — array + dot-path semantics', () => {
  it('nested-object dot-path', () => {
    expect(matchesRecordFilter({ owner: { id: 'u1' } }, { 'owner.id': 'u1' })).toBe(true);
    expect(matchesRecordFilter({ a: { b: { c: 2 } } }, { 'a.b.c': 2 })).toBe(true);
    expect(matchesRecordFilter({ a: { b: {} } }, { 'a.b.c': 2 })).toBe(false);
  });

  it('leaf array field: scalar condition matches any element (contains)', () => {
    expect(matchesRecordFilter({ tags: ['a', 'b'] }, { tags: 'b' })).toBe(true);
    expect(matchesRecordFilter({ tags: ['a', 'b'] }, { tags: 'z' })).toBe(false);
    expect(matchesRecordFilter({ tags: [] }, { tags: 'a' })).toBe(false);
  });

  it('leaf array field: range / $in / regex match any element', () => {
    expect(matchesRecordFilter({ scores: [3, 9] }, { scores: { $gt: 5 } })).toBe(true);
    expect(matchesRecordFilter({ scores: [1, 2] }, { scores: { $gt: 5 } })).toBe(false);
    expect(matchesRecordFilter({ tags: ['x', 'y'] }, { tags: { $in: ['y', 'z'] } })).toBe(true);
    expect(matchesRecordFilter({ tags: ['xx', 'abc'] }, { tags: { $regex: '^ab' } })).toBe(true);
  });

  it('dot-path FANS OUT over subdocument arrays', () => {
    const doc = { items: [{ sku: 'x' }, { sku: 'y' }] };
    expect(matchesRecordFilter(doc, { 'items.sku': 'y' })).toBe(true);
    expect(matchesRecordFilter(doc, { 'items.sku': 'z' })).toBe(false);
    expect(matchesRecordFilter(doc, { 'items.sku': { $in: ['y'] } })).toBe(true);
  });

  it('deep array-of-array-of-object fan-out', () => {
    const doc = { groups: [{ members: [{ id: 1 }, { id: 2 }] }, { members: [{ id: 3 }] }] };
    expect(matchesRecordFilter(doc, { 'groups.members.id': 3 })).toBe(true);
    expect(matchesRecordFilter(doc, { 'groups.members.id': 9 })).toBe(false);
  });
});

// ── Id / type coercion ───────────────────────────────────────────────────

describe('matchesRecordFilter — id + type coercion', () => {
  it('ObjectId-like value matches its string form (eq + $in)', () => {
    const oid = { toString: () => '507f1f77bcf86cd799439011' };
    expect(matchesRecordFilter({ _id: oid }, { _id: '507f1f77bcf86cd799439011' })).toBe(true);
    expect(matchesRecordFilter({ _id: oid }, { _id: { $in: ['507f1f77bcf86cd799439011'] } })).toBe(
      true,
    );
    expect(matchesRecordFilter({ _id: oid }, { _id: 'different' })).toBe(false);
  });

  it('Date matches ISO string; two Dates by instant', () => {
    const d = new Date('2026-07-16T00:00:00.000Z');
    expect(matchesRecordFilter({ at: d }, { at: '2026-07-16T00:00:00.000Z' })).toBe(true);
    expect(matchesRecordFilter({ at: d }, { at: new Date('2026-07-16T00:00:00.000Z') })).toBe(true);
  });

  it('does NOT loosely coerce number vs string (1 !== "1")', () => {
    expect(matchesRecordFilter({ a: 1 }, { a: '1' })).toBe(false);
    expect(matchesRecordFilter({ a: '1' }, { a: 1 })).toBe(false);
  });

  it('plain-object values never equal (no deep equality)', () => {
    expect(matchesRecordFilter({ a: { x: 1 } }, { a: { x: 1 } as never })).toBe(false);
  });
});

// ── Edge + adversarial cases ─────────────────────────────────────────────

describe('matchesRecordFilter — edge + adversarial', () => {
  it('prototype-pollution-safe: crafted `__proto__` / `constructor` paths do not traverse the chain', () => {
    // `toString`/`isPrototypeOf` live on Object.prototype; own-property
    // reads must never surface them.
    expect(matchesRecordFilter({ a: 1 }, { toString: { $exists: true } as never })).toBe(false);
    expect(matchesRecordFilter({ a: 1 }, { 'constructor.name': 'Object' })).toBe(false);
    expect(matchesRecordFilter({ a: 1 }, { '__proto__.polluted': true as never })).toBe(false);
    // A field literally named `__proto__`/`constructor`/`prototype` is
    // DENIED fail-closed (never matched), even as an own property — a
    // policy filter should never key on these, and denying is safer than
    // risking a crafted `JSON.parse('{"__proto__":…}')` own-prop match.
    expect(matchesRecordFilter({ constructor: 'mine' }, { constructor: 'mine' })).toBe(false);
    expect(matchesRecordFilter({ prototype: 'x' }, { prototype: 'x' })).toBe(false);
  });

  it('NaN / Infinity comparisons are well-behaved (no throws, no false-positives)', () => {
    expect(matchesRecordFilter({ n: Number.NaN }, { n: { $gt: 0 } })).toBe(false);
    // NaN equals NaN for MATCH purposes (Mongo semantics, via Object.is).
    expect(matchesRecordFilter({ n: Number.NaN }, { n: Number.NaN })).toBe(true);
    expect(matchesRecordFilter({ n: 1 }, { n: Number.NaN })).toBe(false);
    expect(matchesRecordFilter({ n: Number.POSITIVE_INFINITY }, { n: { $gt: 1e9 } })).toBe(true);
  });

  it('boolean + zero + empty-string values are matched exactly (no truthiness traps)', () => {
    expect(matchesRecordFilter({ active: false }, { active: false })).toBe(true);
    expect(matchesRecordFilter({ active: false }, { active: true })).toBe(false);
    expect(matchesRecordFilter({ n: 0 }, { n: 0 })).toBe(true);
    expect(matchesRecordFilter({ s: '' }, { s: '' })).toBe(true);
  });

  it('undefined field value: eq fails, $ne holds, $exists false', () => {
    expect(matchesRecordFilter({ a: undefined }, { a: 1 })).toBe(false);
    expect(matchesRecordFilter({ a: undefined }, { a: { $ne: 1 } })).toBe(true);
    expect(matchesRecordFilter({ a: undefined }, { a: { $exists: false } })).toBe(true);
  });

  it('empty $or / $and / $nor', () => {
    // Mongo: empty $and → true (vacuous); empty $or → false (no branch).
    expect(matchesRecordFilter({ a: 1 }, { $and: [] })).toBe(true);
    expect(matchesRecordFilter({ a: 1 }, { $or: [] })).toBe(false);
    expect(matchesRecordFilter({ a: 1 }, { $nor: [] })).toBe(true);
  });

  it('fails LOUD on unsupported operators (never silent wrong)', () => {
    expect(() => matchesRecordFilter({ a: 1 }, { a: { $mod: [2, 0] } as never })).toThrow(
      /unsupported field operator/,
    );
    expect(() => matchesRecordFilter({ a: 1 }, { $where: 'x' } as never)).toThrow(
      /unsupported top-level operator/,
    );
    expect(() => matchesRecordFilter({ a: 1 }, { $or: { a: 1 } as never })).toThrow(
      /must be an array/,
    );
  });
});

// ── policyRecordToFilter IR shape ────────────────────────────────────────

describe('policyRecordToFilter — IR shape', () => {
  it('empty → TRUE; single field → eq; $or → or', () => {
    expect(policyRecordToFilter({})).toEqual({ op: 'true' });
    expect(policyRecordToFilter({ ownerId: 'u1' })).toEqual({
      op: 'eq',
      field: 'ownerId',
      value: 'u1',
    });
    expect(policyRecordToFilter({ $or: [{ a: 1 }, { b: 2 }] })).toEqual({
      op: 'or',
      children: [
        { op: 'eq', field: 'a', value: 1 },
        { op: 'eq', field: 'b', value: 2 },
      ],
    });
  });

  it('$regex → regex node with flags', () => {
    expect(policyRecordToFilter({ name: { $regex: '^a', $options: 'i' } })).toMatchObject({
      op: 'regex',
      field: 'name',
      pattern: '^a',
      flags: 'i',
    });
  });
});

// ── MongoDB parity (researched against the MongoDB manual + sift/mingo) ───
// These lock the famous query gotchas that silently break authorization
// filters. The rule underpinning most: an ABSENT field participates in
// comparisons as if it were null/undefined.

describe('matchesRecordFilter — MongoDB parity: missing-field semantics', () => {
  it('#1 `{field: null}` matches present-null AND missing (not 0/false)', () => {
    expect(matchesRecordFilter({ a: null }, { a: null })).toBe(true);
    expect(matchesRecordFilter({}, { a: null })).toBe(true);
    expect(matchesRecordFilter({ b: 1 }, { a: null })).toBe(true);
    expect(matchesRecordFilter({ a: 0 }, { a: null })).toBe(false);
    expect(matchesRecordFilter({ a: false }, { a: null })).toBe(false);
  });

  it('#2 $ne / $nin MATCH a missing field (the top authorization landmine)', () => {
    // `{ status: { $ne: 'archived' } }` must return docs with NO status.
    expect(matchesRecordFilter({}, { status: { $ne: 'archived' } })).toBe(true);
    expect(matchesRecordFilter({ status: 'active' }, { status: { $ne: 'archived' } })).toBe(true);
    expect(matchesRecordFilter({ status: 'archived' }, { status: { $ne: 'archived' } })).toBe(
      false,
    );
    expect(matchesRecordFilter({}, { role: { $nin: ['admin'] } })).toBe(true);
    // `$ne: null` is the exception — requires the field present AND non-null.
    expect(matchesRecordFilter({}, { a: { $ne: null } })).toBe(false);
    expect(matchesRecordFilter({ a: null }, { a: { $ne: null } })).toBe(false);
    expect(matchesRecordFilter({ a: 1 }, { a: { $ne: null } })).toBe(true);
  });

  it('#4 $in/$nin with a null member routes through missing-field logic', () => {
    expect(matchesRecordFilter({}, { a: { $in: [null, 1] } })).toBe(true);
    expect(matchesRecordFilter({ a: null }, { a: { $in: [null, 1] } })).toBe(true);
    expect(matchesRecordFilter({ a: 1 }, { a: { $in: [null, 1] } })).toBe(true);
    expect(matchesRecordFilter({ a: 2 }, { a: { $in: [null, 1] } })).toBe(false);
    // `{ tenant: { $nin: [null, 'public'] } }` ⇒ tenant present, non-null, not 'public'.
    expect(matchesRecordFilter({}, { tenant: { $nin: [null, 'public'] } })).toBe(false);
    expect(matchesRecordFilter({ tenant: 'public' }, { tenant: { $nin: [null, 'public'] } })).toBe(
      false,
    );
    expect(matchesRecordFilter({ tenant: 'acme' }, { tenant: { $nin: [null, 'public'] } })).toBe(
      true,
    );
  });
});

describe('matchesRecordFilter — MongoDB parity: operators + types', () => {
  it('#5 $in accepts RegExp-literal members (OR of regex + scalar)', () => {
    expect(matchesRecordFilter({ name: 'apple' }, { name: { $in: [/^a/, 'x'] } })).toBe(true);
    expect(matchesRecordFilter({ name: 'x' }, { name: { $in: [/^a/, 'x'] } })).toBe(true);
    expect(matchesRecordFilter({ name: 'zoo' }, { name: { $in: [/^a/, 'x'] } })).toBe(false);
  });

  it('#6 comparison is type-bracketed — no cross-type ordering', () => {
    expect(matchesRecordFilter({ age: '10' }, { age: { $gt: 5 } })).toBe(false); // string vs num
    expect(matchesRecordFilter({ age: 10 }, { age: { $gt: 5 } })).toBe(true);
    expect(matchesRecordFilter({ v: '9' }, { v: { $lt: '10' } })).toBe(false); // lexical: '9'<'10' false
  });

  it('#9 $gt: null matches nothing; NaN equals NaN; missing fails ordering', () => {
    expect(matchesRecordFilter({ a: 5 }, { a: { $gt: null } })).toBe(false);
    expect(matchesRecordFilter({ a: Number.NaN }, { a: { $eq: Number.NaN } })).toBe(true);
    expect(matchesRecordFilter({ a: Number.NaN }, { a: { $gt: 0 } })).toBe(false);
    expect(matchesRecordFilter({}, { a: { $gt: 5 } })).toBe(false);
  });

  it('#8 dot-notation numeric segment = positional array index', () => {
    const doc = { items: [{ sku: 'x' }, { sku: 'y' }] };
    expect(matchesRecordFilter(doc, { 'items.0.sku': 'x' })).toBe(true);
    expect(matchesRecordFilter(doc, { 'items.1.sku': 'y' })).toBe(true);
    expect(matchesRecordFilter(doc, { 'items.1.sku': 'x' })).toBe(false);
    expect(matchesRecordFilter(doc, { 'items.9.sku': 'x' })).toBe(false); // out of range
  });

  it('#10 $regex: per-array-element, string-only (no number coercion)', () => {
    expect(matchesRecordFilter({ tags: ['apple', 'b'] }, { tags: { $regex: '^a' } })).toBe(true);
    expect(matchesRecordFilter({ n: 1 }, { n: { $regex: '^1' } })).toBe(false); // number, no match
  });

  it('#11 empty $in → none; empty $nin → all (incl missing); {} → all', () => {
    expect(matchesRecordFilter({ a: 1 }, { a: { $in: [] } })).toBe(false);
    expect(matchesRecordFilter({ a: 1 }, { a: { $nin: [] } })).toBe(true);
    expect(matchesRecordFilter({}, { a: { $nin: [] } })).toBe(true); // missing matches $nin:[]
    expect(matchesRecordFilter({ anything: true }, {})).toBe(true);
  });

  it('DIVERGENCE (documented): $exists = present-and-non-null (SQL/sift), not Mongo key-presence', () => {
    expect(matchesRecordFilter({ a: 1 }, { a: { $exists: true } })).toBe(true);
    expect(matchesRecordFilter({ a: null }, { a: { $exists: true } })).toBe(false);
    expect(matchesRecordFilter({ a: null }, { a: { $exists: false } })).toBe(true);
  });
});

// ── Performance / efficiency ─────────────────────────────────────────────

describe('matchesRecordFilter — performance + efficiency', () => {
  it('evaluates 100k docs against an $or grant filter well under budget (linear, no per-doc regex compile)', () => {
    const filter = { $or: [{ ownerId: 'u1' }, { _id: { $in: ['x', 'y', 'z'] } }] };
    const docs = Array.from({ length: 100_000 }, (_, i) => ({
      _id: `id-${i}`,
      ownerId: i % 2 === 0 ? 'u1' : 'other',
    }));
    const start = performance.now();
    let matched = 0;
    for (const d of docs) if (matchesRecordFilter(d, filter)) matched++;
    const ms = performance.now() - start;
    expect(matched).toBe(50_000); // every even-index doc via the owner branch
    // Generous CI-safe ceiling; the point is "linear + fast", not a microbench.
    expect(ms).toBeLessThan(1_000);
  });

  it('reuses the compiled regex across docs (cache hit, not recompiled per doc)', () => {
    const filter = { name: { $regex: '^user-\\d+$' } };
    const docs = Array.from({ length: 50_000 }, (_, i) => ({ name: `user-${i}` }));
    const start = performance.now();
    let matched = 0;
    for (const d of docs) if (matchesRecordFilter(d, filter)) matched++;
    const ms = performance.now() - start;
    expect(matched).toBe(50_000);
    expect(ms).toBeLessThan(1_000);
  });

  it('does not blow up on a wide $in membership set', () => {
    const ids = Array.from({ length: 10_000 }, (_, i) => `id-${i}`);
    const filter = { _id: { $in: ids } };
    expect(matchesRecordFilter({ _id: 'id-9999' }, filter)).toBe(true);
    expect(matchesRecordFilter({ _id: 'missing' }, filter)).toBe(false);
  });
});
