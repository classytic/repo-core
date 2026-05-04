/**
 * Multi-tenant policy helpers — kit-neutral building blocks.
 *
 * Every kit's `multiTenantPlugin` ships the same payload-inspection
 * and admin-bypass logic. This module is the canonical source so the
 * kits stay byte-identical on these decisions. Each kit still owns
 * its own filter compiler (Mongo `$eq` vs SQL `WHERE col = ?`), but
 * the policy decisions of "should this op bypass the required-scope
 * throw?" and "is this caller a superadmin?" are driver-agnostic.
 *
 * Usage in a kit plugin:
 *
 * ```ts
 * import { payloadHasTenantField } from '@classytic/repo-core/plugins/tenant';
 *
 * if (allowDataInjection && payloadHasTenantField(context, policyKey, tenantField)) {
 *   return; // caller stamped the tenant; trust it (per fail-open opt-in)
 * }
 * ```
 */

import type { PolicyKey } from '../operations/types.js';

/**
 * Minimal context shape this module reads. Kits' richer
 * `RepositoryContext` types extend this — by accepting only the slots
 * we touch, we avoid coupling repo-core to any kit's typing.
 */
export interface TenantPolicyContext {
  readonly data?: Record<string, unknown>;
  readonly dataArray?: readonly Record<string, unknown>[];
  readonly query?: unknown;
  readonly filters?: unknown;
  readonly operations?: unknown;
}

/**
 * True when the op's policy target already has `tenantField` set by
 * the caller. Used to decide whether the plugin can safely skip
 * injecting a tenant scope rather than throwing on a missing context.
 *
 * - `data`       — `context.data[tenantField]` is present
 * - `dataArray`  — every row in `context.dataArray` has `tenantField`
 * - `query`      — `context.query[tenantField]` is present
 * - `filters`    — `context.filters[tenantField]` is present
 * - `operations` — every bulkWrite sub-op's filter/document has `tenantField`
 * - `none`       — unreachable (the hook isn't registered for these ops)
 *
 * For multi-row targets (`dataArray`, `operations`) we require EVERY
 * row to be stamped. Partial stamping is ambiguous (we have no
 * resolver value to fill in the gaps) and is safer to treat as "not
 * stamped" so the caller either stamps all rows or supplies a
 * context/resolver.
 */
export function payloadHasTenantField(
  context: TenantPolicyContext,
  policyKey: PolicyKey,
  tenantField: string,
): boolean {
  switch (policyKey) {
    case 'data':
      return context.data?.[tenantField] != null;
    case 'dataArray': {
      const arr = context.dataArray;
      if (!Array.isArray(arr) || arr.length === 0) return false;
      return arr.every((row) => row && row[tenantField] != null);
    }
    case 'query': {
      const q = context.query as Record<string, unknown> | undefined;
      return q?.[tenantField] != null;
    }
    case 'filters': {
      const f = context.filters as Record<string, unknown> | undefined;
      return f?.[tenantField] != null;
    }
    case 'operations': {
      const ops = context.operations as Record<string, unknown>[] | undefined;
      if (!Array.isArray(ops) || ops.length === 0) return false;
      return ops.every((subOp) => {
        for (const key of ['updateOne', 'updateMany', 'deleteOne', 'deleteMany', 'replaceOne']) {
          const body = subOp[key] as Record<string, unknown> | undefined;
          if (body) {
            const filter = body['filter'] as Record<string, unknown> | undefined;
            return filter?.[tenantField] != null;
          }
        }
        const ins = subOp['insertOne'] as Record<string, unknown> | undefined;
        if (ins) {
          const doc = ins['document'] as Record<string, unknown> | undefined;
          return doc?.[tenantField] != null;
        }
        return false;
      });
    }
    default:
      return false;
  }
}

/**
 * Build a `skipWhen`-compatible callback that bypasses tenant scoping
 * when the caller's role is in `adminRoles`. Composable with any
 * kit's multi-tenant plugin shape.
 *
 * The factory does an exact-match `Set.has` check — case-sensitive,
 * no fuzzy matching. Lowercase your role vocabulary upstream.
 *
 * @example
 * ```ts
 * multiTenantPlugin({
 *   resolveTenantId: ctx => ctx.organizationId,
 *   skipWhen: adminBypass({ adminRoles: ['superadmin', 'support'] }),
 * });
 * ```
 *
 * @param options.roleField  Context key holding the role string (default: `'role'`)
 * @param options.adminRoles Roles that bypass tenant scope. Frozen on
 *   factory construction so callers can't mutate the list afterward
 *   and silently change bypass semantics across plugin instances
 *   sharing the array reference.
 * @returns A `skipWhen`-compatible callback `(ctx, op) → boolean`.
 */
export function adminBypass(options: {
  roleField?: string;
  adminRoles: readonly string[];
}): (context: Record<string, unknown>, operation: string) => boolean {
  const { roleField = 'role', adminRoles } = options;
  const allowed = new Set(adminRoles);
  return function skipWhenAdmin(context) {
    const role = context[roleField];
    return typeof role === 'string' && allowed.has(role);
  };
}
