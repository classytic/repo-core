/**
 * Type-level contract tests for `StandardRepo.getByIds` (optional batch
 * point-read, added 0.9.0).
 *
 * Pins the public shape so:
 *   - kits WITHOUT `getByIds` stay conforming (the member is optional —
 *     adding it must never break existing kits at their conformance gates)
 *   - kits WITH `getByIds` must return `Map<string, TDoc>` keyed by the
 *     stringified id, and must accept `readonly string[]` input
 *   - a kit accepting a WIDER id input (mongokit takes `string | ObjectId`)
 *     still conforms — parameter contravariance is part of the contract
 *
 * No runtime assertions — these compile-time checks fail the test file
 * with type errors if the contract regresses.
 */

import { describe, expect, it } from 'vitest';
import type { FindAllOptions, StandardRepo } from '../../../src/repository/types.js';

interface Doc {
  _id: string;
  name: string;
}

// Minimal conforming StandardRepo surface for the members exercised here.
// Runtime-empty stub, cast — only the `getByIds` member shape is pinned by
// this file; the rest of the contract is pinned elsewhere.
const baseRepo = {} as Omit<StandardRepo<Doc>, 'getByIds'>;

describe('StandardRepo.getByIds — type contract', () => {
  it('kits without getByIds stay conforming (member is optional)', () => {
    const repo: StandardRepo<Doc> = baseRepo;
    expect(typeof repo).toBe('object');
  });

  it('kits with the canonical signature conform', () => {
    const withBatch: StandardRepo<Doc> = {
      ...baseRepo,
      async getByIds(ids: readonly string[], _options?: FindAllOptions) {
        return new Map<string, Doc>(ids.map((id) => [id, { _id: id, name: 'x' }]));
      },
    };
    expect(typeof withBatch.getByIds).toBe('function');
  });

  it('kits accepting a WIDER id input still conform (contravariance)', () => {
    // Mirrors mongokit: `ReadonlyArray<string | ObjectIdLike>` is a
    // supertype of `readonly string[]`, so the impl is assignable.
    const withWiderInput: StandardRepo<Doc> = {
      ...baseRepo,
      async getByIds(ids: readonly (string | { toHexString(): string })[]) {
        return new Map<string, Doc>(ids.map((id) => [String(id), { _id: String(id), name: 'x' }]));
      },
    };
    expect(typeof withWiderInput.getByIds).toBe('function');
  });

  it('wrong return shape is rejected at compile time', () => {
    const bad = {
      ...baseRepo,
      // Array instead of Map — must not satisfy the contract.
      async getByIds(_ids: readonly string[]) {
        return [] as Doc[];
      },
    };
    // @ts-expect-error — getByIds must return Map<string, TDoc>, not TDoc[]
    const repo: StandardRepo<Doc> = bad;
    expect(typeof repo).toBe('object');
  });
});
