/**
 * `validateKeysetSort` (repo-core copy) accepts mixed directions — same
 * contract as mongokit's, for the same reason: the keyset predicate is a
 * per-position tuple comparison, so the directions need not agree.
 */

import { describe, expect, it } from 'vitest';
import { validateKeysetSort } from '../../../src/pagination/keyset.js';

describe('validateKeysetSort — mixed directions', () => {
  it('accepts a mixed-direction compound sort', () => {
    expect(() => validateKeysetSort({ priority: 1, createdAt: -1 })).not.toThrow();
  });

  it('keeps the caller-given _id direction', () => {
    expect(validateKeysetSort({ score: 1, _id: -1 })).toEqual({ score: 1, _id: -1 });
  });

  it('an absent _id follows the primary field', () => {
    expect(validateKeysetSort({ priority: 1, createdAt: -1 })).toEqual({
      priority: 1,
      createdAt: -1,
      _id: 1,
    });
  });
});
