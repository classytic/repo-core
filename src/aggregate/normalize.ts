/**
 * AggRequest → input normalization.
 *
 * Pure, backend-agnostic helpers shared by every kit's aggregate
 * compiler. They don't know about MongoDB, Drizzle, or any driver —
 * they only normalize the portable repo-core IR inputs into a stable
 * shape the downstream kit-specific compilers consume.
 *
 * Centralizing them here is the canonical place: every kit (mongokit,
 * sqlitekit, future pgkit / prismakit) was shipping byte-identical
 * copies. Promoting them to repo-core keeps the IR contract honest —
 * the rules for what a valid AggRequest looks like live with the IR.
 */

import type { AggRequest } from '../repository/types.js';

/**
 * Normalize `AggRequest['groupBy']` into a readonly string array.
 * Returns `[]` for scalar aggregation (no groupBy). Downstream
 * compilers treat `[]` uniformly — Mongo emits `$group: { _id: null }`,
 * SQL emits a single SELECT without a GROUP BY clause.
 */
export function normalizeGroupBy(groupBy: AggRequest['groupBy']): readonly string[] {
  if (!groupBy) return [];
  if (typeof groupBy === 'string') return [groupBy];
  return groupBy;
}

/**
 * Fail loud on an empty measures bag — there's nothing to compute and
 * the caller's code path is almost certainly a wiring bug (conditional
 * collapsed, key renamed, etc.). Silently returning `{ rows: [] }`
 * would mask it.
 *
 * The `kitName` prefix (`'mongokit'`, `'sqlitekit'`, ...) on the error
 * message keeps stack-trace context legible — when a developer sees
 * the throw they know which kit's compiler raised it without having
 * to walk the trace.
 */
export function validateMeasures(measures: AggRequest['measures'], kitName: string): void {
  if (!measures || Object.keys(measures).length === 0) {
    throw new Error(
      `${kitName}/aggregate: AggRequest requires at least one measure — empty measures bag is a wiring bug`,
    );
  }
}
