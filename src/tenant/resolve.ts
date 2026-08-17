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

/**
 * The single `tenantField` value a resource layer wants, or `false` when the
 * option disables scoping entirely.
 *
 * Packages composing an arc resource need exactly this shape for
 * `defineResource({ tenantField })`, and four spine modules independently
 * hand-rolled it — each re-deriving `'organizationId'` as the default and
 * unwrapping `{ tenantField }` by hand. One of those copies omitted the
 * disable branch, so that package silently could not be configured
 * company-wide. This wraps {@link resolveTenantConfig} so the default, the
 * disable semantics, and the object-unwrapping have ONE definition.
 *
 * `false` / `{ enabled: false }` / `{ strategy: 'none' }` all mean "no tenant
 * scoping" and all return `false` — callers get one thing to branch on.
 */
export function resolveTenantField(config?: TenantConfig | boolean): string | false {
  const resolved = resolveTenantConfig(config);
  if (!resolved.enabled || resolved.strategy === 'none') return false;
  return resolved.tenantField;
}

/**
 * Refuse a config that still carries a pre-consolidation tenant key.
 *
 * ## Why this belongs in repo-core and not in each kernel
 *
 * Kernels are migrating from a per-package tenant shape (`multiTenant`, plus a
 * sibling `tenantFieldType` in some) onto {@link TenantConfig} under the key
 * `tenant`. `@classytic/ledger` has landed; catalog, order, cart, crm, flow,
 * party, review, transfer and yard have adopted the TYPE but still read
 * `multiTenant`. Each of those is a future rename.
 *
 * The rename itself is trivial. What is not trivial is the failure mode when a
 * CALLER misses it, because every one of these resolvers reads
 * `resolveTenantConfig(config.tenant ?? false)`: an absent `tenant` resolves to
 * `strategy: 'none'` — no tenant field, no tenant filter, every read spanning
 * ALL tenants, no error, and figures that look plausible. A host that asked for
 * tenancy gets none, silently.
 *
 * Nine packages each remembering to hand-roll that check is nine chances to
 * forget, and the one that forgets is the one that ships the leak. So the guard
 * lives beside the resolver every one of them already calls.
 *
 * Additive and non-breaking: nothing calls it until a package renames.
 *
 * @param config the raw, unresolved shape as the host supplied it
 * @param pkg package name for the message (e.g. `'defineOrder'`)
 * @param extra additional legacy keys this package is retiring, as
 *   `[oldKey, newPath]` — pass `['tenantFieldType', 'tenant.fieldType']` when
 *   the package carried a sibling field-type option.
 */
export function assertNoLegacyTenantKeys(
  config: unknown,
  pkg: string,
  extra: ReadonlyArray<readonly [string, string]> = [],
): void {
  if (config === null || typeof config !== 'object') return;
  const record = config as Record<string, unknown>;
  const retired: ReadonlyArray<readonly [string, string]> = [['multiTenant', 'tenant'], ...extra];
  for (const [key, became] of retired) {
    if (record[key] === undefined) continue;
    throw new Error(
      `${pkg}: \`${key}\` was renamed to \`${became}\`. It is REFUSED rather than ignored ` +
        'because ignoring it disables tenancy SILENTLY — no tenant field, no tenant filter, ' +
        'and every read spanning all tenants while returning plausible numbers. ' +
        `Move the value to \`tenant\` (\`tenant: false\` for a single-tenant deployment).`,
    );
  }
}
