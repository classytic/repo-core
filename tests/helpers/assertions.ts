/**
 * Domain matchers. Per testing-infrastructure.md §3: add these when ≥2 tests
 * want the same assertion shape. Start small; grow only when duplication appears.
 */

import { expect } from 'vitest';
import type { HookPriority } from '../../src/hooks/index.js';

/**
 * Assert that policy hooks run strictly before cache hooks.
 * This is the core invariant: cross-tenant cache poisoning becomes
 * impossible only when tenant scope is injected before the cache key
 * is computed.
 */
export function expectPolicyBeforeCache(policy: HookPriority, cache: HookPriority): void {
  expect(policy, 'POLICY must have a lower priority number than CACHE').toBeLessThan(cache);
}

/**
 * Assert that a list of priorities is in strictly ascending order.
 * Use when checking the canonical phase ordering (policy → cache → observability → default).
 */
export function expectPrioritiesAscending(priorities: readonly HookPriority[]): void {
  for (let i = 1; i < priorities.length; i++) {
    const prev = priorities[i - 1];
    const curr = priorities[i];
    expect(
      prev,
      `priority at index ${String(i - 1)} must be < priority at index ${String(i)}`,
    ).toBeLessThan(curr as number);
  }
}
