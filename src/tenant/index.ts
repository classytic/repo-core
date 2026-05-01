/**
 * Public entry for the `tenant` subpath.
 *
 * Consumers import from `@classytic/repo-core/tenant`. See `types.ts` for
 * the rationale on why the static contract lives in repo-core (next to
 * `context`, `filter`, `hooks` — all the repository-shaped contracts) and
 * not in `@classytic/primitives` (which holds true domain primitives like
 * Money, Address, Period).
 */

export { DEFAULT_TENANT_CONFIG, resolveTenantConfig } from './resolve.js';
export type {
  ResolvedTenantConfig,
  TenantConfig,
  TenantFieldType,
  TenantStrategy,
} from './types.js';
