import { describe, expect, it } from 'vitest';
import {
  CORE_OP_REGISTRY,
  describe as describeOp,
  extendRegistry,
  listOperations,
  mutatingOperations,
  operationsByPolicyKey,
  readOperations,
} from '../../../src/operations/index.js';

describe('CORE_OP_REGISTRY', () => {
  it('is frozen so consumers cannot mutate the shared registry', () => {
    expect(Object.isFrozen(CORE_OP_REGISTRY)).toBe(true);
  });

  it('classifies create as a data-injection mutating op', () => {
    expect(CORE_OP_REGISTRY.create).toEqual({
      policyKey: 'data',
      mutates: true,
      hasIdContext: false,
    });
  });

  it('classifies getAll under the paginated filters bag', () => {
    expect(CORE_OP_REGISTRY.getAll).toEqual({
      policyKey: 'filters',
      mutates: false,
      hasIdContext: false,
    });
  });

  it('classifies update/delete with id context populated', () => {
    expect(CORE_OP_REGISTRY.update.hasIdContext).toBe(true);
    expect(CORE_OP_REGISTRY.delete.hasIdContext).toBe(true);
    expect(CORE_OP_REGISTRY.restore.hasIdContext).toBe(true);
  });

  it('does not include Mongo-specific ops — aggregate, bulkWrite, lookupPopulate stay in mongokit', () => {
    const coreOps = listOperations(CORE_OP_REGISTRY);
    expect(coreOps).not.toContain('aggregate');
    expect(coreOps).not.toContain('aggregatePaginate');
    expect(coreOps).not.toContain('lookupPopulate');
    expect(coreOps).not.toContain('bulkWrite');
  });

  it('exposes exactly the 17 core ops — prevents silent registry drift', () => {
    const coreOps = listOperations(CORE_OP_REGISTRY);
    expect(coreOps).toHaveLength(17);
    expect(coreOps).toEqual(
      expect.arrayContaining([
        'create',
        'update',
        'findOneAndUpdate',
        'delete',
        'restore',
        'createMany',
        'updateMany',
        'deleteMany',
        'getById',
        'getByQuery',
        'getOne',
        'findAll',
        'getOrCreate',
        'count',
        'exists',
        'distinct',
        'getAll',
      ]),
    );
  });
});

describe('registry helpers', () => {
  it('mutatingOperations returns writes only', () => {
    const writes = mutatingOperations(CORE_OP_REGISTRY);
    expect(writes).toContain('create');
    expect(writes).toContain('update');
    expect(writes).toContain('delete');
    expect(writes).not.toContain('getById');
    expect(writes).not.toContain('count');
    expect(writes).not.toContain('getAll');
  });

  it('readOperations returns reads only', () => {
    const reads = readOperations(CORE_OP_REGISTRY);
    expect(reads).toContain('getById');
    expect(reads).toContain('count');
    expect(reads).toContain('getAll');
    expect(reads).not.toContain('create');
    expect(reads).not.toContain('delete');
  });

  it('operationsByPolicyKey groups by injection site', () => {
    expect(operationsByPolicyKey(CORE_OP_REGISTRY, 'data')).toEqual(['create']);
    expect(operationsByPolicyKey(CORE_OP_REGISTRY, 'dataArray')).toEqual(['createMany']);
    expect(operationsByPolicyKey(CORE_OP_REGISTRY, 'filters')).toEqual(['getAll']);
  });

  it('describe returns undefined for unknown ops so plugins can skip without crashing', () => {
    expect(describeOp(CORE_OP_REGISTRY, 'create')).toEqual(CORE_OP_REGISTRY.create);
    expect(describeOp(CORE_OP_REGISTRY, 'notAnOp')).toBeUndefined();
  });
});

describe('extendRegistry', () => {
  it('adds kit-specific operations without mutating the base', () => {
    const extended = extendRegistry(CORE_OP_REGISTRY, {
      aggregate: { policyKey: 'query', mutates: false, hasIdContext: false },
      bulkWrite: { policyKey: 'operations', mutates: true, hasIdContext: false },
    });

    // Base survives
    expect(CORE_OP_REGISTRY).not.toHaveProperty('aggregate');
    expect(listOperations(CORE_OP_REGISTRY)).toHaveLength(17);

    // Extension visible
    expect(describeOp(extended, 'aggregate')).toEqual({
      policyKey: 'query',
      mutates: false,
      hasIdContext: false,
    });
    expect(mutatingOperations(extended)).toContain('bulkWrite');
  });

  it('extension registry is frozen — kits treat it as immutable', () => {
    const extended = extendRegistry(CORE_OP_REGISTRY, {
      custom: { policyKey: 'none', mutates: false, hasIdContext: false },
    });
    expect(Object.isFrozen(extended)).toBe(true);
  });
});
