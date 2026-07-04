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
type TenantDefaults = {
  [K in
    | 'strategy'
    | 'enabled'
    | 'tenantField'
    | 'fieldType'
    | 'ref'
    | 'contextKey'
    | 'required']-?: Exclude<TenantConfig[K], undefined>;
};

// `Exclude<..., undefined>` (not plain `Required<Pick<...>>`) because the
// TenantConfig optionals are explicitly `T | undefined` (P10) and `-?` does
// not strip an explicit undefined union member.
export const DEFAULT_TENANT_CONFIG: TenantDefaults = {
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
/**
 * Drop keys whose value is explicitly `undefined` so `{ ...defaults,
 * ...config }` can never clobber a default with `undefined`. Required now
 * that `TenantConfig` optionals are typed `T | undefined` (P10 /
 * exactOptionalPropertyTypes): callers may legitimately pass
 * `{ required: maybeUndefined }` through from their own optional config.
 */
type NoUndefined<T> = { [K in keyof T]?: Exclude<T[K], undefined> };
function stripUndefined<T extends object>(obj: T): NoUndefined<T> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(obj as Record<string, unknown>)) {
    if (v !== undefined) out[k] = v;
  }
  return out as NoUndefined<T>;
}

export function resolveTenantConfig(config?: TenantConfig | boolean): ResolvedTenantConfig {
  if (config === false) {
    return { ...DEFAULT_TENANT_CONFIG, strategy: 'none', enabled: false, required: false };
  }
  if (config === true || config === undefined) {
    return { ...DEFAULT_TENANT_CONFIG };
  }

  const cleaned = stripUndefined(config);

  const strategy: TenantStrategy =
    cleaned.strategy ?? (cleaned.enabled === false ? 'none' : 'field');

  // `contextKey` cascade: explicit > tenantField > default. When a host
  // renames `tenantField`, their context carries the id under the same key
  // in the overwhelming majority of cases; mirroring the rename is the
  // least-surprise default. Callers who genuinely need a split (doc field
  // ≠ ctx key) must set `contextKey` explicitly.
  const contextKey = cleaned.contextKey ?? cleaned.tenantField ?? DEFAULT_TENANT_CONFIG.contextKey;

  if (strategy === 'none') {
    // Preserve user-supplied `tenantField`, `fieldType`, `ref`, `contextKey`
    // — even when scoping is disabled, the doc field still needs to be
    // typed correctly (e.g. a host that stores string orgIds but opts out
    // of plugin-level enforcement).
    return {
      ...DEFAULT_TENANT_CONFIG,
      ...cleaned,
      contextKey,
      strategy: 'none',
      enabled: false,
      required: false,
    };
  }

  if (strategy === 'custom') {
    if (typeof cleaned.resolve !== 'function') {
      throw new Error("[repo-core] TenantConfig.strategy 'custom' requires a 'resolve' function");
    }
    return {
      ...DEFAULT_TENANT_CONFIG,
      ...cleaned,
      contextKey,
      strategy: 'custom',
      enabled: cleaned.enabled ?? true,
      resolve: cleaned.resolve,
    };
  }

  return {
    ...DEFAULT_TENANT_CONFIG,
    ...cleaned,
    contextKey,
    strategy: 'field',
    enabled: cleaned.enabled ?? true,
  };
}
