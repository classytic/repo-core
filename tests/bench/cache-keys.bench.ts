/**
 * Bench: cache-key derivation hot path.
 *
 * Every cache read/write threads through `buildCacheKey` — measures
 * `stableStringify` + `fnv1a64` overhead in isolation, plus the
 * scope-tag extractor that arc + multi-tenant plugins call on every
 * request.
 *
 * Bench-only file. Skipped in `vitest run`; runs under `vitest bench`.
 */

import { bench, describe } from 'vitest';
import { buildCacheKey, extractScopeTags } from '../../src/cache/keys.js';
import { stableStringify } from '../../src/cache/stable-stringify.js';

const typicalParams = {
  filter: { status: 'active', tenant: 'acme' },
  sort: { createdAt: -1 },
  limit: 25,
};

const largeFilter = {
  filter: {
    status: { $in: ['active', 'pending', 'review'] },
    organizationId: 'org_abc123def456',
    createdAt: { $gte: '2026-01-01', $lt: '2026-04-01' },
    'metadata.region': 'us-east',
    'metadata.tier': { $in: ['gold', 'platinum'] },
    tags: { $all: ['priority', 'verified'] },
    archived: false,
    deletedAt: null,
    score: { $gte: 50, $lt: 100 },
    owner: { $or: [{ id: 'u1' }, { id: 'u2' }] },
  },
  sort: { score: -1, createdAt: -1 },
  limit: 50,
  skip: 100,
};

const aggRequest = {
  groupBy: ['organizationId', 'status'],
  measures: [
    { field: 'amount', op: 'sum' },
    { field: 'amount', op: 'avg' },
    { field: 'id', op: 'count' },
  ],
  filter: {
    organizationId: 'org_abc',
    createdAt: { $gte: '2026-01-01' },
    status: { $in: ['paid', 'shipped'] },
  },
  having: { 'amount.sum': { $gte: 1000 } },
  sort: { 'amount.sum': -1 },
  limit: 100,
};

const scopeContext = {
  filter: {
    organizationId: 'org_abc123',
    userId: 'usr_xyz789',
    status: 'active',
    archived: false,
  },
  options: {},
};

describe('buildCacheKey', () => {
  bench('typical params (filter + sort + limit)', () => {
    buildCacheKey({
      prefix: 'rc',
      operation: 'getAll',
      model: 'orders',
      version: 7,
      params: typicalParams,
      scopeTags: ['org:abc'],
    });
  });

  bench('large filter (10-key nested object)', () => {
    buildCacheKey({
      prefix: 'rc',
      operation: 'getAll',
      model: 'orders',
      version: 7,
      params: largeFilter,
      scopeTags: ['org:abc', 'user:42'],
    });
  });
});

describe('stableStringify', () => {
  bench('typical AggRequest (groupBy + measures + filter)', () => {
    stableStringify(aggRequest);
  });

  bench('typical params object', () => {
    stableStringify(typicalParams);
  });

  bench('large filter object', () => {
    stableStringify(largeFilter);
  });
});

describe('fnv1a64 hash (via buildCacheKey on tiny input)', () => {
  // fnv1a64 isn't exported; bench it indirectly via buildCacheKey on a
  // small fixed-shape input where stableStringify cost is dominated by
  // hash cost. Useful as a relative datapoint vs. the larger benches
  // above.
  const tinyParams = { id: 'abc123' };
  bench('hash via buildCacheKey (tiny params)', () => {
    buildCacheKey({
      prefix: 'rc',
      operation: 'getById',
      model: 'orders',
      version: 1,
      params: tinyParams,
      scopeTags: [],
    });
  });

  // ~200-char string fed through stableStringify (a single primitive
  // string takes the JSON.stringify branch). Approximates raw hash
  // throughput on that-size input.
  const longString = 'x'.repeat(200);
  bench('stableStringify of ~200-char string', () => {
    stableStringify(longString);
  });
});

describe('extractScopeTags', () => {
  bench('filter-injected scope (org + user)', () => {
    extractScopeTags(scopeContext);
  });

  bench('empty context', () => {
    extractScopeTags(undefined);
  });

  bench('top-level fields fallback', () => {
    extractScopeTags({ organizationId: 'org_abc', userId: 'usr_xyz' });
  });
});
