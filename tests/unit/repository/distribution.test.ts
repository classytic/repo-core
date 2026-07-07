/**
 * Distribution-key guard — filter inspection across Filter IR and raw
 * record dialects, warn-once semantics, throw mode, exemptions.
 */

import { describe, expect, it } from 'vitest';
import { and, eq, gt, or } from '../../../src/filter/builders.js';
import {
  createDistributionGuard,
  filterReferencesKey,
} from '../../../src/repository/distribution.js';

describe('filterReferencesKey', () => {
  it('finds the key in Filter IR trees, including nested branches', () => {
    expect(filterReferencesKey(eq('tenantId', 't1'), 'tenantId')).toBe(true);
    expect(filterReferencesKey(and(gt('score', 3), eq('tenantId', 't1')), 'tenantId')).toBe(true);
    expect(filterReferencesKey(or(eq('tenantId', 't1'), eq('tenantId', 't2')), 'tenantId')).toBe(
      true,
    );
    expect(filterReferencesKey(eq('other', 'x'), 'tenantId')).toBe(false);
  });

  it('finds the key in raw records — top level, Mongo and Prisma branches', () => {
    expect(filterReferencesKey({ tenantId: 't1', status: 'a' }, 'tenantId')).toBe(true);
    expect(filterReferencesKey({ $or: [{ tenantId: 't1' }, { status: 'x' }] }, 'tenantId')).toBe(
      true,
    );
    expect(filterReferencesKey({ AND: [{ tenantId: 't1' }] }, 'tenantId')).toBe(true);
    expect(filterReferencesKey({ NOT: { tenantId: 't1' } }, 'tenantId')).toBe(true);
    expect(filterReferencesKey({ status: 'x' }, 'tenantId')).toBe(false);
    expect(filterReferencesKey(undefined, 'tenantId')).toBe(false);
  });
});

describe('createDistributionGuard', () => {
  it('warn mode: fires onMiss once per operation, never on key hits', () => {
    const misses: string[] = [];
    const guard = createDistributionGuard({ key: 'tenantId' }, (info) => {
      misses.push(info.operation);
    });

    guard('findAll', { status: 'x' });
    guard('findAll', { status: 'y' }); // deduped
    guard('updateMany', { status: 'x' });
    guard('findAll', { tenantId: 't1' }); // key present — no miss

    expect(misses).toEqual(['findAll', 'updateMany']);
  });

  it('throw mode rejects the operation with an actionable message', () => {
    const guard = createDistributionGuard({ key: 'tenantId', onMissingKey: 'throw' });
    expect(() => guard('deleteMany', { status: 'x' })).toThrow(/tenantId/);
    expect(() => guard('deleteMany', { tenantId: 't1' })).not.toThrow();
  });

  it('off mode and exempt operations never fire', () => {
    const misses: string[] = [];
    const offGuard = createDistributionGuard({ key: 'k', onMissingKey: 'off' }, () => {
      misses.push('off');
    });
    offGuard('findAll', {});

    const exemptGuard = createDistributionGuard(
      { key: 'k', exemptOperations: ['aggregate'] },
      () => {
        misses.push('exempt');
      },
    );
    exemptGuard('aggregate', {});

    expect(misses).toEqual([]);
  });
});
