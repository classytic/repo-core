/**
 * Cross-kit plugin building blocks.
 *
 * Helpers shipped here are pure logic that every kit's plugins
 * (multi-tenant, soft-delete, audit, ...) consume identically. The
 * driver-specific compilation (Mongo `$eq` vs Drizzle `WHERE`) lives
 * in each kit; the policy decisions live here.
 */

export { adminBypass, payloadHasTenantField, type TenantPolicyContext } from './tenant-helpers.js';
