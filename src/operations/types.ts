/**
 * Operation-registry type definitions.
 *
 * These types are the driver-agnostic classification of every repository
 * operation — where a plugin should inject its scoping filter (for
 * multi-tenant, soft-delete, etc.), whether the operation mutates, and
 * whether it carries a primary-key id on the context. Every driver kit
 * (mongokit, pgkit, prismakit) ships a registry with the same shape so
 * cross-driver plugins work identically.
 */

/** Operations declared by `@classytic/repo-core`. Kits extend this union. */
export type CoreRepositoryOperation =
  // Single-doc writes
  | 'create'
  | 'update'
  | 'findOneAndUpdate'
  | 'delete'
  | 'restore'
  // Multi-doc writes
  | 'createMany'
  | 'updateMany'
  | 'deleteMany'
  // Reads — filter as primary input
  | 'getById'
  | 'getByQuery'
  | 'getOne'
  | 'findAll'
  | 'getOrCreate'
  | 'count'
  | 'exists'
  | 'distinct'
  // Reads — paginated options bag
  | 'getAll';

/**
 * Open repository-operation name. Kits extend the core union with their
 * own native operations (e.g. mongokit's `aggregate`, `bulkWrite`). Plugins
 * that walk a registry use this string type so they don't need to know the
 * full union.
 */
export type RepositoryOperation = CoreRepositoryOperation | (string & {});

/**
 * Where a plugin should inject its scoping filter (multi-tenant scope,
 * soft-delete filter, etc.) on the repository context.
 *
 * - `data`        — single-doc create payload (`context.data`)
 * - `dataArray`   — multi-doc create payload (`context.dataArray`)
 * - `query`       — raw filter (`context.query`); the dominant convention
 * - `filters`     — paginated list options' filter sub-bag (`context.filters`)
 * - `operations`  — bulk-write per-sub-op (plugins walk each entry)
 * - `none`        — no scoping target (op accepts no filter input)
 */
export type PolicyKey = 'data' | 'dataArray' | 'query' | 'filters' | 'operations' | 'none';

/** Classification of a single repository operation. */
export interface OperationDescriptor {
  /** Where multi-tenant / soft-delete plugins inject their scoping filter. */
  readonly policyKey: PolicyKey;
  /** Whether this op writes to the database. Drives audit + cache invalidation. */
  readonly mutates: boolean;
  /** True when `context.id` is populated by the time before/after hooks fire. */
  readonly hasIdContext: boolean;
}

/**
 * Registry shape. Indexed by operation name; values are operation descriptors.
 * Kits compose their registry from `CORE_OP_REGISTRY` plus driver-specific
 * additions (see `extendRegistry`).
 */
export type OperationRegistry<Op extends string = RepositoryOperation> = Readonly<
  Record<Op, OperationDescriptor>
>;
