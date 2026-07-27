/**
 * `resolveTenantField` tests.
 *
 * Pinned behaviour — every branch four spine packages hand-rolled, including
 * the disable branch one of them omitted (making that package impossible to
 * configure company-wide):
 *
 *   1. omitted / `true`  → the default field.
 *   2. `false`           → `false` (scoping off).
 *   3. `{ tenantField }` → that field.
 *   4. `{ enabled: false }` / `{ strategy: 'none' }` → `false`, EVEN when a
 *      `tenantField` is also present — a doc field can be declared for typing
 *      while scoping is off, and callers must not mistake it for a live scope.
 */
import { describe, expect, it } from 'vitest';
import { resolveTenantField } from '../../../src/tenant/resolve.js';

describe('resolveTenantField', () => {
  it('defaults to organizationId when omitted', () => {
    expect(resolveTenantField()).toBe('organizationId');
  });

  it('defaults to organizationId for `true`', () => {
    expect(resolveTenantField(true)).toBe('organizationId');
  });

  it('returns false for `false` — the branch a hand-rolled copy dropped', () => {
    expect(resolveTenantField(false)).toBe(false);
  });

  it('returns the configured tenantField', () => {
    expect(resolveTenantField({ tenantField: 'branchId' })).toBe('branchId');
  });

  it('returns false when explicitly disabled, even with a tenantField present', () => {
    // The field stays declared for schema typing; scoping is still OFF, and
    // returning the name here would silently re-enable per-tenant filtering.
    expect(resolveTenantField({ enabled: false, tenantField: 'branchId' })).toBe(false);
  });

  it("returns false for strategy 'none'", () => {
    expect(resolveTenantField({ strategy: 'none' })).toBe(false);
  });

  it('returns the field for an explicit field strategy', () => {
    expect(resolveTenantField({ strategy: 'field', tenantField: 'companyId' })).toBe('companyId');
  });
});
