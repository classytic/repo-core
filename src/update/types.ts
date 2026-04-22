/**
 * Update IR — driver-agnostic mutation spec.
 *
 * An `UpdateSpec` is a structured description of an atomic update that every
 * kit compiles to its native shape — mongokit emits `$set`/`$unset`/`$inc`/
 * `$setOnInsert` records, SQL kits emit column assignments + `NULL` columns
 * + `column = coalesce(column, 0) + delta`, Prisma emits the equivalent
 * `update` arg.
 *
 * The IR covers the subset every backend supports:
 *
 *   - **set**          — assign field values (mongokit `$set`, SQL column = ?)
 *   - **unset**        — clear fields (mongokit `$unset`, SQL column = NULL)
 *   - **setOnInsert**  — only on upsert insert (mongokit `$setOnInsert`, SQL INSERT default)
 *   - **inc**          — atomic numeric delta (mongokit `$inc`, SQL col = col + ?)
 *
 * Kit-native update features (Mongo `$push`/`$pull`/`$addToSet`, aggregation
 * pipeline updates, Postgres `jsonb_set`, SQL CASE expressions) stay
 * kit-native. Pass a raw Mongo operator record or pipeline array when you
 * need them — the `UpdateInput` union accepts both.
 *
 * **Compat invariant:** mongokit's existing Mongo-operator records (`$set`,
 * `$unset`, ...) are NOT `UpdateSpec` values. Kits route by the `op:
 * 'update'` tag via `isUpdateSpec`, treating raw records as pre-compiled
 * and passing them to the driver unchanged.
 */

/**
 * Portable update spec — the tagged-union root every kit compiles.
 *
 * At least one of `set` / `unset` / `setOnInsert` / `inc` must be populated.
 * An empty spec is a wiring bug (nothing to update); kits MAY treat it as
 * a no-op or throw.
 */
export interface UpdateSpec {
  readonly op: 'update';
  /** Fields to assign. Overrides existing values. */
  readonly set?: Readonly<Record<string, unknown>>;
  /** Fields to clear. Mongo `$unset`, SQL `NULL`. */
  readonly unset?: readonly string[];
  /** Fields to set only when upsert creates a new row. Ignored otherwise. */
  readonly setOnInsert?: Readonly<Record<string, unknown>>;
  /** Atomic numeric deltas. Kits compile to `$inc` / `col = col + ?`. */
  readonly inc?: Readonly<Record<string, number>>;
}

/**
 * Accepted update argument across every write method. A kit's
 * `findOneAndUpdate` / `updateMany` implementation accepts:
 *
 *   1. `UpdateSpec` — portable, kit-agnostic. Compiles to the native shape.
 *   2. `Record<string, unknown>` — kit-native raw record (mongokit
 *      `$`-operators, Prisma `update` input). Passed through unchanged.
 *   3. `Record<string, unknown>[]` — Mongo aggregation pipeline. Mongo-only
 *      kits execute it; SQL kits throw `UnsupportedOperationError`.
 *
 * Arc's stores (outbox, idempotency, audit) should prefer form (1). Forms
 * (2) and (3) remain for kit-specific fast paths and the aggregation-update
 * escape hatch (e.g. outbox's `$ifNull` to preserve `firstFailedAt`).
 */
export type UpdateInput = UpdateSpec | Record<string, unknown> | Record<string, unknown>[];
