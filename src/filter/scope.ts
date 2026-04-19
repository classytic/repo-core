/**
 * Scope-injection helpers.
 *
 * Every policy plugin (multi-tenant, soft-delete, org-boundary) follows the
 * same pattern: AND a predicate into an existing filter while tolerating
 * Filter IR, flat `{ field: value }` records, and `undefined`. These
 * helpers lift that pattern out so every kit's local policy plugins compose
 * the same way.
 */

import { and, eq, TRUE } from './builders.js';
import { isFilter } from './guard.js';
import type { Filter } from './types.js';

/**
 * Inject a tenant-scope predicate into an existing filter.
 *
 * Returns a new filter representing `existing AND tenantField = tenantId`.
 * Handles three existing-filter shapes:
 *   - `undefined` → returns the bare scope predicate
 *   - Filter IR → ANDed onto the tree
 *   - flat record `{ field: value }` → merged field-wise (each existing
 *     key becomes an `eq` node, ANDed with the scope)
 *
 * Used by each kit's `multiTenantPlugin.apply()` to stay consistent
 * without duplicating the merge logic.
 */
export function buildTenantScope(
  existing: Filter | Record<string, unknown> | undefined,
  tenantField: string,
  tenantId: string | number,
): Filter | Record<string, unknown> {
  const scope = eq(tenantField, tenantId);
  if (existing === undefined) return scope;
  if (isFilter(existing)) {
    return existing.op === 'true' ? scope : and(existing, scope);
  }
  // Flat record — merge the tenant field directly. Callers that accept
  // Filter IR on this field get a Filter node when existing was already IR.
  return { ...existing, [tenantField]: tenantId };
}

/**
 * Merge an arbitrary scope predicate into an existing filter.
 *
 * Generalization of `buildTenantScope` — callers pass any Filter IR node
 * (e.g. `isNull('deletedAt')` for soft-delete, `eq('status', 'active')`
 * for policy guards) and this function handles the existing-filter shape
 * matrix. Flat-record existing filters become Filter IR on the way out so
 * the result is always `Filter`-compatible.
 */
export function mergeScope(
  existing: Filter | Record<string, unknown> | undefined,
  scope: Filter,
): Filter {
  if (existing === undefined) return scope;
  if (isFilter(existing)) {
    return existing.op === 'true' ? scope : and(existing, scope);
  }
  const eqs: Filter[] = Object.entries(existing as Record<string, unknown>).map(([f, v]) =>
    eq(f, v),
  );
  if (eqs.length === 0) return scope;
  return and(...eqs, scope);
}

/** Convenience: scope that matches everything — the identity under AND. */
export const SCOPE_ANY: Filter = TRUE;
