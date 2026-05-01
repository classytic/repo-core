/**
 * Framework-agnostic adapter contract — the binding between any HTTP /
 * resource framework (arc, future arc-next, custom hosts) and a kit's
 * concrete `Repository`.
 *
 * The shape is deliberately framework-free. A kit's `createXxxAdapter()`
 * factory produces a `DataAdapter<TDoc>` that any consumer of repo-core's
 * `RepositoryLike<TDoc>` can wire into its own resource layer — no kit
 * needs an arc peer-dep.
 *
 * Arc consumes this contract via `defineResource({ adapter })`. Other
 * frameworks (Express, Hono, Nest, the next arc-next) can consume the
 * same `DataAdapter` shape; the kit ships one adapter, every host wires
 * it the same way.
 */

import type { MinimalRepo, StandardRepo } from '../repository/index.js';
import type { SchemaBuilderOptions } from '../schema/types.js';

/**
 * Cross-kit repository contract.
 *
 * Defined as `MinimalRepo<TDoc> & Partial<StandardRepo<TDoc>>` — the
 * 5-method floor every kit must implement, plus every other
 * `StandardRepo` method (atomic CAS, batch ops, aggregation, soft-delete,
 * transactions) as optional. Hosts feature-detect optional methods at
 * call sites; kits declare only what they implement.
 *
 * **Why compound and not `StandardRepo` alone:** forcing every kit to
 * implement the full surface would break kits with partial capabilities
 * (sqlitekit has no aggregation, prismakit has no native atomic CAS the
 * same way). Hosts use `typeof repo.method === 'function'` checks at
 * construction.
 *
 * **Why compound and not `MinimalRepo` alone:** internal subsystems
 * (audit, outbox, idempotency stores) need `StandardRepo` type info at
 * call sites. `Partial<StandardRepo>` keeps the type-level backing
 * without forcing every kit to implement everything.
 */
export type RepositoryLike<TDoc = unknown> = MinimalRepo<TDoc> & Partial<StandardRepo<TDoc>>;

/**
 * Permissive structural input accepted at every adapter factory boundary.
 *
 * Wider than `RepositoryLike<TDoc>` on `getAll`'s `params`/`options` —
 * uses method-shorthand syntax with `unknown` so kit-native repository
 * classes plug in directly without `as RepositoryLike<TDoc>` casts on
 * the host.
 *
 * **Why this exists.** repo-core 0.2 widened `MinimalRepo['getAll']`'s
 * `params.filters` to a `Filter | Record<string, unknown>` IR union, but
 * concrete kit `Repository` classes still type `filters` as the narrower
 * `Record<string, unknown>`. Under `strictFunctionTypes` the kit's
 * narrower function-property `getAll` is no longer assignable to the
 * IR-aware one, which forced every host adapter glue file to write
 * `repository as unknown as RepositoryLike<TDoc>`.
 *
 * Adapter factories accept this permissive shape, then call
 * `asRepositoryLike()` once to widen for host internals (which still see
 * the strict `RepositoryLike` view). The documented escape hatch lives
 * in repo-core, not at every host call site.
 */
export interface AdapterRepositoryInput<TDoc = unknown> {
  readonly idField?: string;
  getAll(params?: unknown, options?: unknown): Promise<unknown>;
  getById(id: string, options?: unknown): Promise<TDoc | null>;
  create(data: Partial<TDoc>, options?: unknown): Promise<TDoc>;
  update(id: string, data: Partial<TDoc>, options?: unknown): Promise<TDoc | null>;
  delete(
    id: string,
    options?: unknown,
  ): Promise<{
    success: boolean;
    message: string;
    id?: string;
    soft?: boolean;
    count?: number;
  }>;
}

/**
 * Generic OpenAPI-shaped schema bag emitted by `DataAdapter.generateSchemas`.
 *
 * Loose `unknown` slots so kits emit JSON Schema or kit-native shapes
 * without type pressure. Hosts that want a specific shape (Fastify route
 * schemas, Zod models, ...) narrow on consumption.
 */
export interface OpenApiSchemas {
  /** Resource entity schema (the row shape). */
  entity?: unknown;
  /** Create-body schema (POST / PUT body). */
  createBody?: unknown;
  /** Update-body schema (PATCH body). */
  updateBody?: unknown;
  /** Path-params schema (`/:id`). */
  params?: unknown;
  /** List-query querystring schema (filtering / pagination / sort). */
  listQuery?: unknown;
  /**
   * Response schema for OpenAPI documentation. Auto-derived from the
   * entity / create-body shape if omitted.
   */
  response?: unknown;
  [key: string]: unknown;
}

/**
 * Context passed to `adapter.generateSchemas()` so adapters shape output
 * to match host-level configuration. All fields optional — adapters that
 * ignore this still work; the host applies its own normalization.
 */
export interface AdapterSchemaContext {
  /** The `idField` configured on the resource. Defaults to `_id`. */
  idField?: string;
  /** Resource name (for error messages / logging). */
  resourceName?: string;
}

/**
 * Field-level metadata returned by `getSchemaMetadata()`. JSON-Schema-
 * adjacent vocabulary kept driver-free so introspection tooling can
 * consume any kit's output uniformly.
 */
export interface FieldMetadata {
  type: 'string' | 'number' | 'boolean' | 'date' | 'object' | 'array' | 'objectId' | 'enum';
  required?: boolean;
  unique?: boolean;
  default?: unknown;
  enum?: Array<string | number>;
  min?: number;
  max?: number;
  minLength?: number;
  maxLength?: number;
  pattern?: string;
  description?: string;
  ref?: string;
  array?: boolean;
}

/**
 * Relation metadata returned by `getSchemaMetadata()`.
 */
export interface RelationMetadata {
  type: 'one-to-one' | 'one-to-many' | 'many-to-many';
  target: string;
  foreignKey?: string;
  through?: string;
}

/**
 * Schema metadata returned by `getSchemaMetadata()`. Shape-only — no kit
 * types leak through.
 */
export interface SchemaMetadata {
  name: string;
  fields: Record<string, FieldMetadata>;
  indexes?: Array<{ fields: string[]; unique?: boolean; sparse?: boolean }>;
  relations?: Record<string, RelationMetadata>;
}

/**
 * Result of `adapter.validate()`. Structurally identical to repo-core's
 * `schema/types.ts` `ValidationResult` for the message/violations shape,
 * but uses `errors[]` (the OpenAPI/AJV convention) for adapter-time
 * validation. Kept distinct so adapter validation and update-body
 * validation can evolve independently.
 */
export interface AdapterValidationResult {
  valid: boolean;
  errors?: Array<{ field: string; message: string; code?: string }>;
}

/**
 * Cross-framework data-adapter contract.
 *
 * A kit's `createXxxAdapter()` factory produces an instance of this
 * interface. Frameworks (arc, custom hosts) consume the same shape; the
 * kit never imports the framework.
 */
export interface DataAdapter<TDoc = unknown> {
  /**
   * Repository implementing CRUD operations. Any value that satisfies
   * `RepositoryLike<TDoc>` — which includes `StandardRepo<TDoc>` (all
   * methods implemented), `MinimalRepo<TDoc>` (5-method floor), or
   * anything in between a kit declares. Hosts feature-detect optional
   * methods at runtime.
   */
  repository: RepositoryLike<TDoc>;

  /** Adapter identifier for introspection. */
  readonly type: 'mongoose' | 'prisma' | 'drizzle' | 'typeorm' | 'custom';

  /** Human-readable name. */
  readonly name: string;

  /**
   * Generate OpenAPI-shaped schemas for CRUD operations. Each adapter
   * produces schemas appropriate to its ORM/database (mongokit
   * introspects Mongoose paths; sqlitekit introspects Drizzle columns).
   *
   * Options use repo-core's `SchemaBuilderOptions` floor — host-specific
   * extensions (arc's `RouteSchemaOptions`) extend this base structurally.
   *
   * @param options - Schema generation options (field rules, populate hints).
   * @param context - Resource-level context (`idField` for params shape,
   *   `name` for logs).
   */
  generateSchemas?(
    options?: SchemaBuilderOptions,
    context?: AdapterSchemaContext,
  ): OpenApiSchemas | Record<string, unknown> | null;

  /** Extract schema metadata for OpenAPI / introspection. */
  getSchemaMetadata?(): SchemaMetadata | null;

  /** Validate data against schema before persistence. */
  validate?(data: unknown): Promise<AdapterValidationResult> | AdapterValidationResult;

  /** Health check for database connection. */
  healthCheck?(): Promise<boolean>;

  /**
   * Custom filter matching for in-memory policy enforcement. Falls back
   * to the host's built-in shallow matcher when omitted. Override for
   * SQL adapters, non-Mongo operators, or kits that compile Filter IR.
   */
  matchesFilter?: (item: unknown, filters: Record<string, unknown>) => boolean;

  /** Close / cleanup resources. */
  close?(): Promise<void>;

  /**
   * Optional: does the underlying schema declare a path with this name?
   *
   * Used by hosts (e.g. arc's `defineResource()`) to infer absent tenant
   * fields — without this hook, hosts who forget `tenantField: false` on
   * cross-tenant tables get queries silently filtered to zero results.
   * Adapters that can introspect their schema implement it; ones that
   * can't omit it (the host falls back to its default behaviour).
   *
   * Implementation guidance:
   *   - Mongoose: `Boolean(this.model.schema.paths[name])`.
   *   - Drizzle / SQL kits: check column metadata.
   *
   * @returns `true` if the schema declares the path, `false` if not,
   *   `undefined` if the adapter can't determine it (treated as
   *   "unknown" — same as omitting the method).
   */
  hasFieldPath?(name: string): boolean | undefined;
}

/**
 * Adapter factory signature. A kit's `createXxxAdapter(config)` matches
 * this shape — config is kit-specific so adapters can accept their own
 * options (e.g. `{ model, schemaGenerator, ... }`).
 */
export type AdapterFactory<TDoc = unknown> = (config: unknown) => DataAdapter<TDoc>;
