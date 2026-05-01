/**
 * `toCanonicalList()` is the single point where a repository result becomes
 * an HTTP wire envelope. These tests pin:
 *
 *   1. Bare arrays → `BareListResponse` (no `method` field).
 *   2. Paginated results → matching `*Response` shape with `success: true`
 *      and the `method` discriminant preserved.
 *   3. `TExtra` fields (mongokit's `warning?: string`, etc.) flow through.
 *   4. The `isPaginatedResult` guard branches on `method`, not array-ness,
 *      so an empty paginated result still routes correctly.
 *   5. The `success` literal is `true` (not widened to `boolean`) — locks
 *      the discriminated-union contract for typed clients.
 */

import { describe, expect, expectTypeOf, it } from 'vitest';
import { isPaginatedResult, toCanonicalList } from '../../../src/pagination/canonical.js';
import type {
  AggregatePaginationResult,
  BareListResponse,
  KeysetPaginationResult,
  OffsetPaginationResponse,
  OffsetPaginationResult,
  PaginatedResponse,
} from '../../../src/pagination/types.js';

interface User {
  id: string;
  name: string;
}
const u1: User = { id: 'u1', name: 'Alice' };
const u2: User = { id: 'u2', name: 'Bob' };

describe('isPaginatedResult', () => {
  it('returns true for offset results', () => {
    const r: OffsetPaginationResult<User> = {
      method: 'offset',
      docs: [u1],
      page: 1,
      limit: 20,
      total: 1,
      pages: 1,
      hasNext: false,
      hasPrev: false,
    };
    expect(isPaginatedResult(r)).toBe(true);
  });

  it('returns true for keyset results', () => {
    const r: KeysetPaginationResult<User> = {
      method: 'keyset',
      docs: [u1],
      limit: 20,
      hasMore: false,
      next: null,
    };
    expect(isPaginatedResult(r)).toBe(true);
  });

  it('returns true for aggregate results', () => {
    const r: AggregatePaginationResult<User> = {
      method: 'aggregate',
      docs: [u1],
      page: 1,
      limit: 20,
      total: 1,
      pages: 1,
      hasNext: false,
      hasPrev: false,
    };
    expect(isPaginatedResult(r)).toBe(true);
  });

  it('returns false for arrays', () => {
    expect(isPaginatedResult([u1, u2])).toBe(false);
    expect(isPaginatedResult([])).toBe(false);
  });

  it('returns false for objects without a method discriminant', () => {
    expect(isPaginatedResult({ docs: [u1] } as never)).toBe(false);
    expect(isPaginatedResult({ method: 'something-else', docs: [] } as never)).toBe(false);
  });

  it('returns false for null / non-object inputs', () => {
    expect(isPaginatedResult(null as never)).toBe(false);
    expect(isPaginatedResult(undefined as never)).toBe(false);
  });

  it('does not falsely accept arrays that happen to have a method property attached', () => {
    // Edge case: an array with extra props would still be Array.isArray=true.
    // The guard must reject it because the wire shape is the bare-array branch.
    const arr = [u1, u2] as User[] & { method?: string };
    arr.method = 'offset';
    expect(isPaginatedResult(arr)).toBe(false);
  });
});

describe('toCanonicalList — bare arrays', () => {
  it('wraps a non-empty array as BareListResponse', () => {
    const out = toCanonicalList([u1, u2]);
    expect(out).toEqual({ success: true, docs: [u1, u2] });
    expect('method' in out).toBe(false);
  });

  it('wraps an empty array', () => {
    const out = toCanonicalList<User>([]);
    expect(out).toEqual({ success: true, docs: [] });
  });

  it('does not mutate the input array', () => {
    const input = [u1];
    toCanonicalList(input);
    expect(input).toEqual([u1]);
    expect(input).toHaveLength(1);
  });

  it('produces a fresh docs array (no aliasing)', () => {
    const input = [u1];
    const out = toCanonicalList(input);
    expect(out.docs).not.toBe(input);
  });
});

describe('toCanonicalList — paginated results', () => {
  it('preserves offset shape and stamps success: true', () => {
    const r: OffsetPaginationResult<User> = {
      method: 'offset',
      docs: [u1],
      page: 1,
      limit: 20,
      total: 1,
      pages: 1,
      hasNext: false,
      hasPrev: false,
    };
    const out = toCanonicalList(r);
    expect(out).toMatchObject({
      success: true,
      method: 'offset',
      docs: [u1],
      page: 1,
      limit: 20,
      total: 1,
      pages: 1,
      hasNext: false,
      hasPrev: false,
    });
  });

  it('preserves keyset shape', () => {
    const r: KeysetPaginationResult<User> = {
      method: 'keyset',
      docs: [u1],
      limit: 20,
      hasMore: true,
      next: 'cursor-abc',
    };
    const out = toCanonicalList(r);
    expect(out).toMatchObject({
      success: true,
      method: 'keyset',
      docs: [u1],
      limit: 20,
      hasMore: true,
      next: 'cursor-abc',
    });
  });

  it('preserves aggregate shape', () => {
    const r: AggregatePaginationResult<User> = {
      method: 'aggregate',
      docs: [u1, u2],
      page: 1,
      limit: 20,
      total: 2,
      pages: 1,
      hasNext: false,
      hasPrev: false,
    };
    const out = toCanonicalList(r);
    expect(out.method).toBe('aggregate');
    expect(out.docs).toHaveLength(2);
  });

  it('flows TExtra fields through (mongokit warning case)', () => {
    type WithWarning = OffsetPaginationResult<User, { warning?: string }>;
    const r: WithWarning = {
      method: 'offset',
      docs: [],
      page: 100,
      limit: 20,
      total: 2000,
      pages: 100,
      hasNext: false,
      hasPrev: true,
      warning: 'Deep pagination: consider keyset.',
    };
    const out = toCanonicalList(r);
    // The TExtra field survives the round-trip.
    expect((out as { warning?: string }).warning).toContain('Deep pagination');
  });

  it('does not lose method when paginated.docs is empty', () => {
    const r: OffsetPaginationResult<User> = {
      method: 'offset',
      docs: [],
      page: 1,
      limit: 20,
      total: 0,
      pages: 0,
      hasNext: false,
      hasPrev: false,
    };
    const out = toCanonicalList(r);
    expect(out.method).toBe('offset');
    expect(out.docs).toEqual([]);
  });

  it('does not let an external success: false on the input override success: true', () => {
    // Defensive: if a kit ever produced a result envelope with a stale
    // `success` field, the wire envelope must still emit `success: true`
    // (paginated success path). Order of spread matters; this test pins it.
    const dirty = {
      method: 'offset',
      docs: [u1],
      page: 1,
      limit: 20,
      total: 1,
      pages: 1,
      hasNext: false,
      hasPrev: false,
      // biome-ignore lint/suspicious/noExplicitAny: deliberate stale-field test
    } as any;
    dirty.success = false;
    const out = toCanonicalList(dirty);
    expect(out.success).toBe(true);
  });
});

describe('type-level contracts', () => {
  it('bare array overload returns BareListResponse<T>', () => {
    const out = toCanonicalList([u1]);
    expectTypeOf(out).toMatchTypeOf<BareListResponse<User>>();
  });

  it('paginated overload returns PaginatedResponse<T>', () => {
    const r: OffsetPaginationResult<User> = {
      method: 'offset',
      docs: [],
      page: 1,
      limit: 20,
      total: 0,
      pages: 0,
      hasNext: false,
      hasPrev: false,
    };
    const out = toCanonicalList(r);
    // Returned shape is assignable to OffsetPaginationResponse — narrows
    // via the `method` discriminant on the union.
    if (out.success && 'method' in out && out.method === 'offset') {
      expectTypeOf(out).toMatchTypeOf<OffsetPaginationResponse<User>>();
    }
  });

  it('PaginatedResponse union narrows via success + method', () => {
    const wire: PaginatedResponse<User> = {
      success: true,
      method: 'offset',
      docs: [u1],
      page: 1,
      limit: 20,
      total: 1,
      pages: 1,
      hasNext: false,
      hasPrev: false,
    };
    if (wire.success && 'method' in wire && wire.method === 'offset') {
      // Narrowed — `page` is visible without a cast.
      expect(wire.page).toBe(1);
    }
  });
});
