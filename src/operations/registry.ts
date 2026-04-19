/**
 * Core operation registry.
 *
 * Classifies every driver-agnostic repository operation. Kits extend this
 * via `extendRegistry` to add their own native operations (mongokit's
 * `aggregate`/`bulkWrite`, pgkit's `copyFrom`, etc.) without duplicating
 * the core classifications.
 *
 * Why a registry instead of hardcoded arrays: before this pattern every
 * plugin (multi-tenant, soft-delete, audit, cache) maintained its own list
 * of "ops I care about". Adding a new method meant touching every plugin
 * and missing one was silent. With the registry, plugins switch on
 * `policyKey` / `mutates` / `hasIdContext` — one descriptor entry is
 * enough to classify an op everywhere.
 */

import type {
  CoreRepositoryOperation,
  OperationDescriptor,
  OperationRegistry,
  PolicyKey,
  RepositoryOperation,
} from './types.js';

/**
 * The core registry. Driver kits merge their own descriptors on top of this
 * via `extendRegistry`.
 */
export const CORE_OP_REGISTRY: OperationRegistry<CoreRepositoryOperation> = Object.freeze({
  // ── Single-doc writes ────────────────────────────────────────────────
  create: { policyKey: 'data', mutates: true, hasIdContext: false },
  update: { policyKey: 'query', mutates: true, hasIdContext: true },
  findOneAndUpdate: { policyKey: 'query', mutates: true, hasIdContext: false },
  delete: { policyKey: 'query', mutates: true, hasIdContext: true },
  restore: { policyKey: 'query', mutates: true, hasIdContext: true },

  // ── Multi-doc writes ─────────────────────────────────────────────────
  createMany: { policyKey: 'dataArray', mutates: true, hasIdContext: false },
  updateMany: { policyKey: 'query', mutates: true, hasIdContext: false },
  deleteMany: { policyKey: 'query', mutates: true, hasIdContext: false },

  // ── Reads — filter as primary input ──────────────────────────────────
  // `findAll` is classified as a read even though its first positional arg
  // is a filter; it matches update/findOneAndUpdate/getOne semantics. Its
  // raw filter lands on `context.query`, not `context.filters`, because
  // `filters` is reserved for paginated options-bag ops.
  //
  // `getOrCreate` is classified as a read so plugins treat it as read-shaped
  // for routing; its conditional create path is an internal detail.
  getById: { policyKey: 'query', mutates: false, hasIdContext: true },
  getByQuery: { policyKey: 'query', mutates: false, hasIdContext: false },
  getOne: { policyKey: 'query', mutates: false, hasIdContext: false },
  findAll: { policyKey: 'query', mutates: false, hasIdContext: false },
  getOrCreate: { policyKey: 'query', mutates: false, hasIdContext: false },
  count: { policyKey: 'query', mutates: false, hasIdContext: false },
  exists: { policyKey: 'query', mutates: false, hasIdContext: false },
  distinct: { policyKey: 'query', mutates: false, hasIdContext: false },

  // ── Reads — paginated options bag (`context.filters`) ────────────────
  getAll: { policyKey: 'filters', mutates: false, hasIdContext: false },
});

/**
 * Merge additional operations into a base registry. Returns a frozen object.
 *
 * Kits call this at module load:
 * ```ts
 * export const MONGOKIT_OP_REGISTRY = extendRegistry(CORE_OP_REGISTRY, {
 *   aggregate: { policyKey: 'query', mutates: false, hasIdContext: false },
 *   aggregatePaginate: { policyKey: 'filters', mutates: false, hasIdContext: false },
 *   lookupPopulate: { policyKey: 'filters', mutates: false, hasIdContext: false },
 *   bulkWrite: { policyKey: 'operations', mutates: true, hasIdContext: false },
 * });
 * ```
 *
 * The return type preserves both the base union and the extension keys, so
 * plugins can still narrow on specific op names when they need to.
 */
export function extendRegistry<
  Base extends string,
  Extra extends Record<string, OperationDescriptor>,
>(base: OperationRegistry<Base>, extra: Extra): OperationRegistry<Base | (keyof Extra & string)> {
  return Object.freeze({ ...base, ...extra }) as OperationRegistry<Base | (keyof Extra & string)>;
}

/** All known operation names in the registry, in insertion order. */
export function listOperations<Op extends string>(registry: OperationRegistry<Op>): Op[] {
  return Object.keys(registry) as Op[];
}

/** Operations that mutate the database — drives audit + cache invalidation. */
export function mutatingOperations<Op extends string>(registry: OperationRegistry<Op>): Op[] {
  return listOperations(registry).filter((op) => registry[op].mutates);
}

/** Operations that don't mutate — drives default cacheable-op lists. */
export function readOperations<Op extends string>(registry: OperationRegistry<Op>): Op[] {
  return listOperations(registry).filter((op) => !registry[op].mutates);
}

/** Filter ops by their policy-injection key. */
export function operationsByPolicyKey<Op extends string>(
  registry: OperationRegistry<Op>,
  key: PolicyKey,
): Op[] {
  return listOperations(registry).filter((op) => registry[op].policyKey === key);
}

/**
 * Look up a descriptor. Returns `undefined` when the op isn't registered —
 * plugins should treat an unknown op as "ignore" rather than crash, so new
 * kits can introduce operations without every plugin needing an update.
 */
export function describe<Op extends string>(
  registry: OperationRegistry<Op>,
  op: RepositoryOperation,
): OperationDescriptor | undefined {
  return Object.hasOwn(registry, op) ? registry[op as Op] : undefined;
}
