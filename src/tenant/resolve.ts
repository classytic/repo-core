/**
 * `resolveTenantConfig` — normalise a `TenantConfig | boolean | undefined`
 * input into the canonical {@link ResolvedTenantConfig} shape, applying
 * defaults and validating the `'custom'` strategy.
 *
 * Hosts and kits call this ONCE at config time so downstream code can read
 * the resolved fields without repeating defaults logic.
 */

import type { ResolvedTenantConfig, TenantConfig, TenantStrategy } from './types.js';

/**
 * Sensible defaults for a freshly-built package (field strategy).
 *
 * `fieldType: 'objectId'` is the recommended default for new Mongo-shaped
 * kits because it enables `$lookup` / `.populate()`. Existing kits that
 * historically defaulted to `'string'` (mongokit pre-3.x) keep their own
 * runtime default — `Pick<TenantConfig, 'fieldType'>` extension preserves
 * type-level alignment without forcing a runtime default change.
 */
export const DEFAULT_TENANT_CONFIG: Required<
  Pick<
    TenantConfig,
    'strategy' | 'enabled' | 'tenantField' | 'fieldType' | 'ref' | 'contextKey' | 'required'
  >
> = {
  strategy: 'field',
  enabled: true,
  tenantField: 'organizationId',
  fieldType: 'objectId',
  ref: 'organization',
  contextKey: 'organizationId',
  required: true,
};

/**
 * Resolve a possibly-partial {@link TenantConfig} against the defaults.
 *
 * - `false` → `enabled: false`, `strategy: 'none'`, `required: false`.
 * - `true` / `undefined` → default field strategy.
 * - Object with `strategy: 'custom'` → `resolve` is required; throws
 *   otherwise so the misconfiguration surfaces at boot, not runtime.
 * - Object with `strategy: 'none'` → `enabled: false` (preserves
 *   user-supplied `tenantField` / `fieldType` / `ref` so the doc field
 *   stays correctly typed even with scoping off).
 */
export function resolveTenantConfig(config?: TenantConfig | boolean): ResolvedTenantConfig {
  if (config === false) {
    return { ...DEFAULT_TENANT_CONFIG, strategy: 'none', enabled: false, required: false };
  }
  if (config === true || config === undefined) {
    return { ...DEFAULT_TENANT_CONFIG };
  }

  const strategy: TenantStrategy = config.strategy ?? (config.enabled === false ? 'none' : 'field');

  // `contextKey` cascade: explicit > tenantField > default. When a host
  // renames `tenantField`, their context carries the id under the same key
  // in the overwhelming majority of cases; mirroring the rename is the
  // least-surprise default. Callers who genuinely need a split (doc field
  // ≠ ctx key) must set `contextKey` explicitly.
  const contextKey = config.contextKey ?? config.tenantField ?? DEFAULT_TENANT_CONFIG.contextKey;

  if (strategy === 'none') {
    // Preserve user-supplied `tenantField`, `fieldType`, `ref`, `contextKey`
    // — even when scoping is disabled, the doc field still needs to be
    // typed correctly (e.g. a host that stores string orgIds but opts out
    // of plugin-level enforcement).
    return {
      ...DEFAULT_TENANT_CONFIG,
      ...config,
      contextKey,
      strategy: 'none',
      enabled: false,
      required: false,
    };
  }

  if (strategy === 'custom') {
    if (typeof config.resolve !== 'function') {
      throw new Error("[repo-core] TenantConfig.strategy 'custom' requires a 'resolve' function");
    }
    return {
      ...DEFAULT_TENANT_CONFIG,
      ...config,
      contextKey,
      strategy: 'custom',
      enabled: config.enabled ?? true,
      resolve: config.resolve,
    };
  }

  return {
    ...DEFAULT_TENANT_CONFIG,
    ...config,
    contextKey,
    strategy: 'field',
    enabled: config.enabled ?? true,
  };
}
