import { describe, expect, it } from 'vitest';
import { HOOK_PRIORITY } from '../../../src/hooks/index.js';
import { expectPolicyBeforeCache, expectPrioritiesAscending } from '../../helpers/assertions.js';
import { makePriorityBundle, sortedByPriority } from '../../helpers/fixtures.js';

describe('HOOK_PRIORITY', () => {
  it('exposes POLICY, CACHE, OBSERVABILITY, DEFAULT', () => {
    expect(HOOK_PRIORITY).toMatchObject({
      POLICY: expect.any(Number),
      CACHE: expect.any(Number),
      OBSERVABILITY: expect.any(Number),
      DEFAULT: expect.any(Number),
    });
  });

  it('guarantees POLICY < CACHE so scope filters land in cache keys', () => {
    expectPolicyBeforeCache(HOOK_PRIORITY.POLICY, HOOK_PRIORITY.CACHE);
  });

  it('orders phases: POLICY → CACHE → OBSERVABILITY → DEFAULT', () => {
    expectPrioritiesAscending([
      HOOK_PRIORITY.POLICY,
      HOOK_PRIORITY.CACHE,
      HOOK_PRIORITY.OBSERVABILITY,
      HOOK_PRIORITY.DEFAULT,
    ]);
  });

  it('fixture sorts phases in registration order regardless of insertion order', () => {
    const bundle = makePriorityBundle();
    const sorted = sortedByPriority(bundle);
    expect(sorted.map(([name]) => name)).toEqual(['POLICY', 'CACHE', 'OBSERVABILITY', 'DEFAULT']);
  });
});
