/**
 * Fixture builders. Per testing-infrastructure.md §3:
 *   - Each builder takes `Partial<T>` overrides so tests don't collide on ids/emails.
 *   - Builders never call `describe`/`it`. They return values or register hooks.
 *   - Keep them pure so they're hoist-safe inside `vi.mock(...)` factories.
 *
 * repo-core is driver-free, so fixtures here are all pure values —
 * filter nodes, repository contexts, hook-capturing spies. Kit packages
 * (mongokit, pgkit) layer their own DB seeders on top.
 */

import type { HookPriority } from '../../src/hooks/index.js';
import { HOOK_PRIORITY } from '../../src/hooks/index.js';

/**
 * Build a minimal hook-priority record for ordering assertions.
 * Use this in tests that verify the priority ordering invariant.
 */
export function makePriorityBundle(
  overrides: Partial<Record<keyof typeof HOOK_PRIORITY, HookPriority>> = {},
): Record<keyof typeof HOOK_PRIORITY, HookPriority> {
  return {
    POLICY: HOOK_PRIORITY.POLICY,
    CACHE: HOOK_PRIORITY.CACHE,
    OBSERVABILITY: HOOK_PRIORITY.OBSERVABILITY,
    DEFAULT: HOOK_PRIORITY.DEFAULT,
    ...overrides,
  };
}

/** Reverse a priority record into sorted-order tuples for deterministic assertions. */
export function sortedByPriority(
  bundle: Record<string, HookPriority>,
): Array<readonly [string, HookPriority]> {
  return Object.entries(bundle)
    .map(([name, priority]) => [name, priority] as const)
    .sort((a, b) => a[1] - b[1]);
}
