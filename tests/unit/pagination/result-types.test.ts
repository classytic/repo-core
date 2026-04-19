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
  KeysetPaginationResult,
  KeysetPaginationResultCore,
  OffsetPaginationResult,
  OffsetPaginationResultCore,
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
