/**
 * `runDataAccessConformance` gating: an undeclared capability SKIPS its group (named in the
 * title), a declared one without its fixture FAILS, a declared one with a fixture RUNS.
 */

import { describe, expect, it } from 'vitest';
import { dataAccessGroupState } from '../../../src/testing/data-access-conformance.js';

const base = { transactions: false, nestedTransactions: false } as const;

describe('dataAccessGroupState', () => {
  it('skips a group whose capability is not declared, even with a fixture', () => {
    expect(dataAccessGroupState({ ...base }, 'scopedJoins', () => undefined)).toBe('skip');
    expect(dataAccessGroupState({ ...base, scopedJoins: false }, 'scopedJoins', () => undefined)).toBe('skip');
  });

  it('fails a declared capability that supplies no fixture (an unproven declaration)', () => {
    expect(dataAccessGroupState({ ...base, getByIdsOrdered: true }, 'getByIdsOrdered', undefined)).toBe(
      'missing-fixture',
    );
  });

  it('runs a declared capability with its fixture', () => {
    expect(dataAccessGroupState({ ...base, getByIdsOrdered: true }, 'getByIdsOrdered', () => undefined)).toBe('run');
  });
});
