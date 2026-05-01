/**
 * Type-level coverage for `OffsetPaginationResult<TDoc, TExtra>` /
 * `KeysetPaginationResult<TDoc, TExtra>`.
 *
 * The TExtra generic is the contract that lets kits surface typed extras
 * (mongokit's `warning?: string`, future pgkit's `queryPlan`, etc.) on the
 * standard envelope without breaking cross-kit substitutability. These
 * assertions lock in:
 *
 *   1. Default `TExtra` is a no-op — `Result<TDoc>` keeps working.
 *   2. `TExtra` adds fields on top, discoverable via autocomplete.
 *   3. The `method` discriminant still narrows the union correctly.
 */

import { describe, expect, it } from 'vitest';
import type {
  AggregatePaginationResponse,
  AggregatePaginationResult,
  AggregatePaginationResultCore,
  AnyPaginationResult,
  BareListResponse,
  KeysetPaginationResponse,
  KeysetPaginationResult,
  KeysetPaginationResultCore,
  OffsetPaginationResponse,
  OffsetPaginationResult,
  OffsetPaginationResultCore,
  PaginatedResponse,
} from '../../../src/pagination/index.js';

describe('OffsetPaginationResult<TDoc, TExtra>', () => {
  it('default TExtra leaves the core shape unchanged', () => {
    const result: OffsetPaginationResult<{ id: string }> = {
      method: 'offset',
      docs: [{ id: 'u1' }],
      page: 1,
      limit: 20,
      total: 1,
      pages: 1,
      hasNext: false,
      hasPrev: false,
    };
    expect(result.method).toBe('offset');
    expect(result.docs).toHaveLength(1);
  });

  it('TExtra adds typed fields on the envelope', () => {
    type WithWarning = OffsetPaginationResult<{ id: string }, { warning?: string }>;
    const result: WithWarning = {
      method: 'offset',
      docs: [],
      page: 100,
      limit: 20,
      total: 2000,
      pages: 100,
      hasNext: false,
      hasPrev: true,
      warning: 'Deep pagination: consider keyset instead.',
    };
    expect(result.warning).toContain('Deep pagination');
  });

  it('Core interface is directly usable (named so StandardRepo contracts can reference it)', () => {
    const core: OffsetPaginationResultCore<{ id: string }> = {
      method: 'offset',
      docs: [],
      page: 1,
      limit: 20,
      total: 0,
      pages: 0,
      hasNext: false,
      hasPrev: false,
    };
    expect(core.method).toBe('offset');
  });

  it('method discriminant narrows even with TExtra intersected', () => {
    type Paged =
      | OffsetPaginationResult<{ id: string }, { warning?: string }>
      | KeysetPaginationResult<{ id: string }>;
    const result: Paged = {
      method: 'offset',
      docs: [],
      page: 1,
      limit: 20,
      total: 0,
      pages: 0,
      hasNext: false,
      hasPrev: false,
    };
    if (result.method === 'offset') {
      // TypeScript narrows to OffsetPaginationResult here — `warning` and
      // `page` are both visible.
      expect(result.page).toBe(1);
      expect(result.warning).toBeUndefined();
    }
  });
});

describe('KeysetPaginationResult<TDoc, TExtra>', () => {
  it('default TExtra leaves the core shape unchanged', () => {
    const result: KeysetPaginationResult<{ id: string }> = {
      method: 'keyset',
      docs: [{ id: 'u1' }],
      limit: 20,
      hasMore: false,
      next: null,
    };
    expect(result.method).toBe('keyset');
    expect(result.next).toBeNull();
  });

  it('TExtra parallels offset — kits can tag cursor-format metadata', () => {
    type WithCursorVersion = KeysetPaginationResult<{ id: string }, { cursorVersion: number }>;
    const result: WithCursorVersion = {
      method: 'keyset',
      docs: [],
      limit: 20,
      hasMore: false,
      next: null,
      cursorVersion: 2,
    };
    expect(result.cursorVersion).toBe(2);
  });

  it('Core interface is exported for StandardRepo references', () => {
    const core: KeysetPaginationResultCore<{ id: string }> = {
      method: 'keyset',
      docs: [],
      limit: 20,
      hasMore: false,
      next: null,
    };
    expect(core.method).toBe('keyset');
  });
});

describe('AggregatePaginationResult<TDoc, TExtra>', () => {
  it('default TExtra leaves the core shape unchanged', () => {
    const result: AggregatePaginationResult<{ id: string }> = {
      method: 'aggregate',
      docs: [{ id: 'u1' }],
      page: 1,
      limit: 20,
      total: 1,
      pages: 1,
      hasNext: false,
      hasPrev: false,
    };
    expect(result.method).toBe('aggregate');
  });

  it('TExtra adds typed fields (mongokit warning)', () => {
    type WithWarning = AggregatePaginationResult<{ id: string }, { warning?: string }>;
    const result: WithWarning = {
      method: 'aggregate',
      docs: [],
      page: 100,
      limit: 20,
      total: 2000,
      pages: 100,
      hasNext: false,
      hasPrev: true,
      warning: 'Deep aggregate pagination is expensive.',
    };
    expect(result.warning).toContain('expensive');
  });

  it('Core interface is directly usable', () => {
    const core: AggregatePaginationResultCore<{ id: string }> = {
      method: 'aggregate',
      docs: [],
      page: 1,
      limit: 20,
      total: 0,
      pages: 0,
      hasNext: false,
      hasPrev: false,
    };
    expect(core.method).toBe('aggregate');
  });
});

describe('AnyPaginationResult<TDoc>', () => {
  it('discriminant narrows across all three result kinds', () => {
    const offset: AnyPaginationResult<{ id: string }> = {
      method: 'offset',
      docs: [],
      page: 1,
      limit: 20,
      total: 0,
      pages: 0,
      hasNext: false,
      hasPrev: false,
    };
    const keyset: AnyPaginationResult<{ id: string }> = {
      method: 'keyset',
      docs: [],
      limit: 20,
      hasMore: false,
      next: null,
    };
    const aggregate: AnyPaginationResult<{ id: string }> = {
      method: 'aggregate',
      docs: [],
      page: 1,
      limit: 20,
      total: 0,
      pages: 0,
      hasNext: false,
      hasPrev: false,
    };
    // Each of these narrows correctly via the discriminant.
    if (offset.method === 'offset') expect(offset.page).toBe(1);
    if (keyset.method === 'keyset') expect(keyset.next).toBeNull();
    if (aggregate.method === 'aggregate') expect(aggregate.page).toBe(1);
  });
});

describe('Wire envelopes — { success: true } & *Result', () => {
  it('OffsetPaginationResponse intersects success: true with the result', () => {
    const wire: OffsetPaginationResponse<{ id: string }> = {
      success: true,
      method: 'offset',
      docs: [],
      page: 1,
      limit: 20,
      total: 0,
      pages: 0,
      hasNext: false,
      hasPrev: false,
    };
    expect(wire.success).toBe(true);
    expect(wire.method).toBe('offset');
  });

  it('KeysetPaginationResponse', () => {
    const wire: KeysetPaginationResponse<{ id: string }> = {
      success: true,
      method: 'keyset',
      docs: [],
      limit: 20,
      hasMore: false,
      next: null,
    };
    expect(wire.method).toBe('keyset');
  });

  it('AggregatePaginationResponse', () => {
    const wire: AggregatePaginationResponse<{ id: string }> = {
      success: true,
      method: 'aggregate',
      docs: [],
      page: 1,
      limit: 20,
      total: 0,
      pages: 0,
      hasNext: false,
      hasPrev: false,
    };
    expect(wire.method).toBe('aggregate');
  });

  it('BareListResponse has no method discriminant', () => {
    const wire: BareListResponse<{ id: string }> = {
      success: true,
      docs: [{ id: 'u1' }],
    };
    expect(wire.success).toBe(true);
    expect('method' in wire).toBe(false);
  });

  it('PaginatedResponse union covers all four wire shapes', () => {
    // Compile-time check: each shape is assignable to the union.
    const a: PaginatedResponse<{ id: string }> = {
      success: true,
      method: 'offset',
      docs: [],
      page: 1,
      limit: 20,
      total: 0,
      pages: 0,
      hasNext: false,
      hasPrev: false,
    };
    const b: PaginatedResponse<{ id: string }> = {
      success: true,
      method: 'keyset',
      docs: [],
      limit: 20,
      hasMore: false,
      next: null,
    };
    const c: PaginatedResponse<{ id: string }> = {
      success: true,
      method: 'aggregate',
      docs: [],
      page: 1,
      limit: 20,
      total: 0,
      pages: 0,
      hasNext: false,
      hasPrev: false,
    };
    const d: PaginatedResponse<{ id: string }> = { success: true, docs: [] };
    expect([a.method, b.method, c.method, 'docs' in d]).toEqual([
      'offset',
      'keyset',
      'aggregate',
      true,
    ]);
  });
});
