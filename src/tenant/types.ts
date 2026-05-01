/**
 * Tenant scope configuration — canonical static contract for the org.
 *
 * **`@classytic/repo-core/tenant` is the single source of truth.** Every
 * multi-tenant-capable package (`@classytic/mongokit`, `@classytic/sqlitekit`,
 * future kits, arc presets, services) consumes {@link TenantConfig} for its
 * static fields and extends with kit-specific runtime callbacks via
 * `Pick<TenantConfig, ...>` to lock the field vocabulary by structural typing.
 *
 * Three strategies are supported:
 * - `'field'` (default) — filter every query by a scalar field on documents.
 *   The common case; used by `multiTenantPlugin` in mongokit and sqlitekit.
 * - `'none'` — disable scoping entirely (single-tenant app). Equivalent to
 *   `enabled: false`; `strategy: 'none'` is the explicit form.
 * - `'custom'` — caller supplies a `resolve(ctx)` function that returns the
 *   filter shape to inject. **The escape hatch for custom systems** —
 *   covers multi-field composite tenants, context-derived filters
 *   (region + partner id), non-scalar scope keys, or any tenancy model that
 *   doesn't fit the simple `field === id` pattern.
 *
 * **Why this layer is static-only.** Runtime callbacks (`skipWhen(ctx, op)`,
 * `resolveContext()`, `resolveTenantId(ctx)`) genuinely differ across kits
 * because their `RepositoryContext` shapes differ — mongokit's resolver
 * returns just an id, sqlitekit's takes a richer context object. Each kit
 * extends `TenantConfig` with its own runtime-callback fields. Hosts who
 * need a single config object can compose: pass the static `TenantConfig`
 * through {@link resolveTenantConfig} once, then forward the resolved
 * static fields into each kit's runtime options alongside the kit-specific
 * callbacks.
 */

/**
 * Storage / cast strategy for the tenant identifier on documents.
 *
 * - `'objectId'` (recommended for new packages) — `Schema.Types.ObjectId`
 *   with `ref`. Enables `$lookup`, `.populate()`, QueryParser `?lookup=...`
 *   on Mongo-shaped kits. SQL kits typically ignore this and rely on
 *   schema-defined column types instead.
 * - `'string'` — plain string. Use when the host auth system issues UUIDs
 *   or slugs rather than ObjectIds.
 */
export type TenantFieldType = 'objectId' | 'string';

/** Scope resolution strategy. */
export type TenantStrategy = 'field' | 'none' | 'custom';

export interface TenantConfig {
  /**
   * Scope strategy. Omit for the common `'field'` case — explicit `'none'`
   * / `'custom'` lets packages collapse what used to live in a separate
   * `ScopeConfig` type.
   *
   * @default 'field'
   */
  strategy?: TenantStrategy;

  /**
   * Whether tenant scoping is active. When `false`, the package runs in
   * single-tenant mode — no filter injection, no tenant field on documents.
   * Equivalent to `strategy: 'none'`.
   *
   * @default true
   */
  enabled?: boolean;

  /**
   * Document / column field name that stores the tenant id. Used when
   * `strategy === 'field'`.
   *
   * @default 'organizationId'
   */
  tenantField?: string;

  /**
   * How to store / cast the tenant id.
   *
   * @default 'objectId'
   */
  fieldType?: TenantFieldType;

  /**
   * Mongoose ref for `'objectId'` types. Ignored by SQL kits and when
   * `fieldType === 'string'`.
   *
   * @default 'organization'
   */
  ref?: string;

  /**
   * Which key on the repository context to read the tenant id from.
   *
   * Defaults cascade: if omitted, falls back to the caller's `tenantField`
   * (if supplied), else to `'organizationId'`. Rationale: when a host renames
   * `tenantField` to e.g. `'branchId'`, their context almost always carries
   * the value under the same key — mirroring `tenantField` is the
   * least-surprise behavior. Override explicitly if the context key diverges
   * from the document field (e.g. `tenantField: 'branchId'`,
   * `contextKey: 'organizationId'`).
   *
   * @default tenantField ?? 'organizationId'
   */
  contextKey?: string;

  /**
   * Whether the field is required. When `false`, the package permits
   * unscoped / cross-tenant reads (typically only for admin paths).
   *
   * @default true
   */
  required?: boolean;

  /**
   * Custom resolver — called when `strategy === 'custom'` to produce the
   * filter object injected into queries. Packages pass the request /
   * repository context; the resolver returns the filter shape.
   *
   * Use for tenancy models that don't fit the simple `field === id`
   * pattern: multi-field composites, context-derived filters
   * (region + partner id), hash-derived shards, etc.
   *
   * @example
   * ```ts
   * {
   *   strategy: 'custom',
   *   resolve: (ctx) => ({
   *     organizationId: ctx.organizationId,
   *     region: ctx.region,
   *     partnerId: ctx.partnerId,
   *   }),
   * }
   * ```
   */
  resolve?: (ctx: Record<string, unknown>) => Record<string, unknown>;
}

/**
 * Resolved shape returned by `resolveTenantConfig`. Always includes the
 * field defaults (so packages can inspect field names even when
 * `enabled: false`) and threads `resolve` when `strategy === 'custom'`.
 */
export type ResolvedTenantConfig = {
  strategy: TenantStrategy;
  enabled: boolean;
  tenantField: string;
  fieldType: TenantFieldType;
  ref: string;
  contextKey: string;
  required: boolean;
  resolve?: TenantConfig['resolve'];
};
