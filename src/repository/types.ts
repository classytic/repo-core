/**
 * Repository contract types — the minimum structural surface every kit
 * (mongokit, sqlitekit, pgkit, prismakit) and every ad-hoc non-kit
 * implementation agrees on.
 *
 * `MinimalRepo<TDoc>` is deliberately tiny: five required methods and one
 * optional identity field. Arc's `RepositoryLike` accepts anything matching
 * this shape, so hosts can pass their own custom `Map`-backed or HTTP-proxy
 * repos through to arc without depending on the heavier `RepositoryBase`
 * class in `repo-core/repository/base`.
 *
 * `StandardRepo<TDoc>` extends `MinimalRepo` with the recommended surface
 * (atomic CAS, compound filter reads, duplicate-key classification, soft
 * delete, batch ops, portable aggregation, transactions). Kits targeting
 * arc 2.10+ should aim for this shape. Kit-native power APIs that don't
 * translate across backends (mongo pipeline, Drizzle builders, Prisma
 * extensions) stay kit-specific — see each kit's docs.
 */

import type { Filter } from '../filter/types.js';
import type { LookupPopulateOptions, LookupPopulateResult } from '../lookup/types.js';
import type { OffsetPaginationResult } from '../pagination/types.js';
import type { UpdateInput } from '../update/types.js';

// ──────────────────────────────────────────────────────────────────────
// Filter input type
// ──────────────────────────────────────────────────────────────────────

/**
 * Accepted filter input across every repository method. A repository
 * call can pass either a plain record (`{ status: 'active' }`) or a
 * Filter IR node (`and(eq('status', 'active'), gt('age', 18))`) — every
 * kit's compiler handles both forms. Kit-native power filters (raw SQL
 * fragments, Mongo `$expr`) still live on the kit's own types; this
 * union covers the portable path.
 */
export type FilterInput = Filter | Record<string, unknown>;

// ──────────────────────────────────────────────────────────────────────
// Transaction handle
// ──────────────────────────────────────────────────────────────────────

/**
 * Opaque transaction session handle. Each driver binds this to its
 * concrete type (`mongoose.ClientSession`, `pg.PoolClient`, `better-sqlite3`
 * transaction function, Prisma transaction client, ...). Code that passes
 * the session through uses `unknown`; kits narrow at the boundary.
 */
export type RepositorySession = unknown;

// ──────────────────────────────────────────────────────────────────────
// Option bags
// ──────────────────────────────────────────────────────────────────────

/**
 * Read-operation options. The index signature is the escape hatch kits use
 * for driver-specific flags (`populate`, `select`, `readPreference`,
 * `__pgHint`, ...). Namespace custom flags to avoid collisions with future
 * arc-reserved keys.
 */
export interface QueryOptions {
  /**
   * Mongoose-style session handle. Threaded through every call so mongoose
   * knows the op is inside a transaction — the driver has no other way to
   * discover that.
   *
   * **SQL / Prisma kits don't use this field.** Their transactions are
   * connection-scoped (SQL) or client-scoped (Prisma): `withTransaction(fn)`
   * hands the callback a `txRepo` whose internal driver is already bound to
   * the transaction, so op methods pick up the tx automatically. Callers who
   * stay on the bound-`txRepo` pattern never touch `session`.
   *
   * Kept on the common `QueryOptions` so mongokit can read it on every op
   * and so arc stores (outbox, idempotency) can forward it where necessary.
   */
  session?: RepositorySession;
  /** Return plain objects rather than driver documents. */
  lean?: boolean;
  /** Include soft-deleted docs in reads (honored by soft-delete plugin). */
  includeDeleted?: boolean;
  /** Request-scoped user metadata forwarded to policy/tenant hooks. */
  user?: Record<string, unknown>;
  /** Arc request context (orgId, roles, requestId, ...). */
  context?: Record<string, unknown>;
  /** Driver-specific escape hatch — see JSDoc. */
  [key: string]: unknown;
}

/** Write-operation options. Superset of `QueryOptions`. */
export interface WriteOptions extends QueryOptions {
  /** Upsert on update/replace. */
  upsert?: boolean;
}

/**
 * Delete-operation options.
 *
 * `mode: 'hard'` opts out of soft-delete interception when the kit has a
 * soft-delete plugin wired. Policy, cascade, audit, and cache hooks still
 * fire — only the soft-delete rewrite is bypassed. Use for GDPR erasure /
 * admin purge. Kits without soft-delete MUST accept and ignore the flag.
 */
export interface DeleteOptions extends QueryOptions {
  mode?: 'hard' | 'soft';
}

/**
 * Compare-and-set options for `findOneAndUpdate`. The four core knobs
 * (`sort`, `returnDocument`, `upsert`, `session`) are cross-driver; the
 * index signature lets kits thread through their own additions.
 */
export interface FindOneAndUpdateOptions extends QueryOptions {
  /** Sort disambiguating when the filter matches multiple docs (FIFO claim). */
  sort?: Record<string, unknown>;
  /** Return doc state before or after the update. Default: 'after'. */
  returnDocument?: 'before' | 'after';
  /** Insert when no doc matches. Default: false. */
  upsert?: boolean;
}

// ──────────────────────────────────────────────────────────────────────
// Result envelopes
// ──────────────────────────────────────────────────────────────────────

/** Result of a single delete — matches mongokit's shape. */
export interface DeleteResult {
  success: boolean;
  message: string;
  /** Primary key of the removed doc (string form). */
  id?: string;
  /** True when a soft-delete plugin intercepted the operation. */
  soft?: boolean;
  /** For batch-variant implementations that surface the count inline. */
  count?: number;
}

/** Result of a batch delete. */
export interface DeleteManyResult {
  acknowledged?: boolean;
  deletedCount: number;
  /** True when a soft-delete plugin rewrote the op to an updateMany. */
  soft?: boolean;
}

/** Result of a bulk update. */
export interface UpdateManyResult {
  acknowledged?: boolean;
  matchedCount: number;
  modifiedCount: number;
  upsertedCount?: number;
  upsertedId?: unknown;
}

/**
 * Heterogeneous bulk-write operation. Mongo-shaped so arc code written
 * against mongokit's `bulkWrite` drops into any kit that implements the
 * StandardRepo `bulkWrite?` method.
 *
 * Kit-specific constraints apply:
 *
 *   - SQL/Prisma kits evaluate `updateOne.update` as a flat column
 *     overwrite, not a MongoDB operator expression (no `$set`, `$inc`).
 *     Pass raw column values.
 *   - `updateOne` / `replaceOne` on SQL kits typically route through a
 *     SELECT-then-UPDATE because `UPDATE ... LIMIT 1` isn't portable.
 *   - `upsert: true` on kits without a native compound unique key may
 *     require the filter to be a flat-literal record (so the kit can
 *     merge filter + update into an INSERT).
 */
export type BulkWriteOperation<TDoc = unknown> =
  | { insertOne: { document: Partial<TDoc> } }
  | {
      updateOne: {
        filter: Record<string, unknown>;
        update: Record<string, unknown>;
        upsert?: boolean;
      };
    }
  | {
      updateMany: {
        filter: Record<string, unknown>;
        update: Record<string, unknown>;
        upsert?: boolean;
      };
    }
  | { deleteOne: { filter: Record<string, unknown> } }
  | { deleteMany: { filter: Record<string, unknown> } }
  | {
      replaceOne: {
        filter: Record<string, unknown>;
        replacement: Partial<TDoc>;
        upsert?: boolean;
      };
    };

/**
 * Result envelope for `bulkWrite`. Mongo-shaped — arc's idempotency /
 * outbox adapters read the same fields regardless of backend.
 *
 * `insertedIds` / `upsertedIds` are keyed by the operation's index in
 * the input array, matching mongoose's convention.
 */
export interface BulkWriteResult {
  ok?: number;
  insertedCount?: number;
  matchedCount?: number;
  modifiedCount?: number;
  deletedCount?: number;
  upsertedCount?: number;
  insertedIds?: Record<number, unknown>;
  upsertedIds?: Record<number, unknown>;
}

// ──────────────────────────────────────────────────────────────────────
// Aggregation IR — portable shape for group-by / summary queries
// ──────────────────────────────────────────────────────────────────────

/**
 * A single named aggregation. Mongo-style operator names because they're
 * the lowest common denominator across SQL and MongoDB — `count` / `sum`
 * / `avg` / `min` / `max` / `countDistinct` map cleanly to both
 * `COUNT(*)` + `GROUP BY` in SQL and `{ $group: { _id, x: { $sum: ... } } }`
 * in Mongo.
 *
 * `count` is the only measure whose `field` is optional: `{ op: 'count' }`
 * counts rows in the group (`COUNT(*)` / `$sum: 1`). With a field name
 * it counts non-null values.
 *
 * Kit compilers normalize unknown ops to a runtime error — keep the set
 * tight so aggregations compile identically everywhere.
 */
export type AggMeasure =
  | { op: 'count'; field?: string }
  | { op: 'countDistinct'; field: string }
  | { op: 'sum'; field: string }
  | { op: 'avg'; field: string }
  | { op: 'min'; field: string }
  | { op: 'max'; field: string };

/**
 * Portable aggregation request. Compiles to SQL (`SELECT ... WHERE ...
 * GROUP BY ... HAVING ... ORDER BY ... LIMIT ... OFFSET`) on sqlitekit /
 * pgkit and to a `[$match, $group, $match, $sort, $limit, $skip]`
 * pipeline on mongokit. Output shape is identical either way: one row
 * per group, keyed by `groupBy` fields + measure aliases.
 *
 * Without `groupBy`: returns a single row of scalar aggregates over the
 * full filtered set. With `groupBy`: one row per distinct group.
 *
 * `filter` and `having` both reuse the Filter IR — `filter` narrows the
 * rows that feed into the aggregate (WHERE), `having` narrows the
 * aggregated result (HAVING). Use `having` to reference measure aliases
 * (`{ field: 'revenue', op: 'gt', value: 1000 }`); kit compilers
 * substitute the aggregate expression when the field matches a measure.
 *
 * Power features that don't translate across backends — `$lookup`,
 * `$unwind`, window functions, CTEs — stay kit-native. Reach for
 * mongokit's `aggregatePipeline` or sqlitekit's raw `repo.db` when you
 * need them.
 */
export interface AggRequest {
  /** Pre-aggregate predicate. Reuses Filter IR; compiles to WHERE / `$match`. */
  filter?: unknown;
  /** Grouping columns. Single string, array of strings, or omitted for scalar aggregation. */
  groupBy?: string | readonly string[];
  /**
   * Named aggregations. At least one key required — an empty `measures`
   * bag is a wiring bug (nothing to compute).
   */
  measures: Record<string, AggMeasure>;
  /** Post-aggregate predicate. Reuses Filter IR; references measure aliases. */
  having?: unknown;
  /** Order the grouped rows. Keys may be `groupBy` fields or measure aliases. */
  sort?: Record<string, 1 | -1>;
  /** Row cap; applied after `having` + `sort`. */
  limit?: number;
  /** Skip N grouped rows. Paginated callers use `aggregatePaginate` instead. */
  offset?: number;
}

/**
 * Paginated variant of `AggRequest`. Returns the standard offset
 * pagination envelope — same shape as `getAll({ page, limit })` so UI
 * code renders aggregates and raw document lists with the same
 * pagination primitives.
 */
export interface AggPaginationRequest extends Omit<AggRequest, 'limit' | 'offset'> {
  /** 1-indexed page number. Defaults to 1. */
  page?: number;
  /** Rows per page. Defaults to the kit's standard limit. */
  limit?: number;
  /**
   * `exact` runs `COUNT(DISTINCT groupBy)` (or `COUNT(*)` for scalar
   * aggregates) alongside the data query. `none` skips the count
   * entirely — the envelope's `total` / `pages` are 0 and `hasNext` is
   * derived from a `LIMIT N+1` peek. Defaults to `exact`.
   */
  countStrategy?: 'exact' | 'none';
}

/**
 * Shape of each row returned by `aggregate` / `aggregatePaginate`.
 * Keys are the `groupBy` fields (when present) plus the measure
 * aliases. Values are SQL-native scalars — numbers for count / sum /
 * avg, the group-by column's native type for group keys.
 *
 * Generic defaults to `Record<string, unknown>` because cross-kit
 * callers usually don't need the narrower type — cast at the call
 * site with your own `interface RevenueByCategory { ... }` if you do.
 */
export type AggRow = Record<string, unknown>;

/** Unpaginated aggregation result. Just an array — no envelope. */
export interface AggResult<TRow extends AggRow = AggRow> {
  rows: TRow[];
}

// ──────────────────────────────────────────────────────────────────────
// Pagination
// ──────────────────────────────────────────────────────────────────────

/**
 * Pagination parameters. Auto-detects three modes:
 *
 * - **Offset** — `page` + `limit` given.
 * - **Keyset** — `sort` + `limit` (+ optional `after` cursor) given.
 * - **Raw** — neither; kit returns all matching docs (may be large).
 */
export interface PaginationParams<TDoc = unknown> {
  /**
   * Predicate narrowing the rows that feed into the list query. Accepts
   * the portable Filter IR (`and(eq(...), gt(...))`) OR a flat kit-native
   * record (`{ status: 'active', age: { $gt: 18 } }`). Every kit's
   * `getAll` compiler handles both forms.
   *
   * The `Partial<TDoc>` intersection preserves the old "typed flat record"
   * DX for callers that pass a POJO — they still get autocomplete on
   * known document fields while the union branch allows the Filter IR.
   */
  filters?: (Partial<TDoc> & Record<string, unknown>) | Filter;
  sort?: string | Record<string, 1 | -1>;
  page?: number;
  limit?: number;
  /** Opaque cursor token from a prior `next` field. */
  after?: string;
  /** Escape hatch for kit-specific options (select, search, populate, ...). */
  [key: string]: unknown;
}

/**
 * Extract document type from any repository. Useful downstream for
 * generic helpers:
 *
 * ```ts
 * type UserDoc = InferDoc<typeof userRepo>;
 * ```
 */
export type InferDoc<R> = R extends MinimalRepo<infer T> ? T : never;

// ──────────────────────────────────────────────────────────────────────
// MinimalRepo — the five-method floor
// ──────────────────────────────────────────────────────────────────────

/**
 * Absolute minimum repository contract. Arc's `BaseController` makes no
 * assumption beyond these methods — if a repo satisfies `MinimalRepo`,
 * arc's auto-generated CRUD routes will work against it.
 *
 * Target audience:
 * - Kit authors (mongokit, sqlitekit, pgkit): implement this first, then
 *   layer `StandardRepo` optional capabilities on top.
 * - App authors: stub repositories in unit tests without a DB. A `Map`-backed
 *   mock implementing `MinimalRepo` passes all of arc's type checks.
 * - Gateway/proxy authors: wrap a remote service as a local repository by
 *   implementing these five methods around HTTP calls.
 *
 * @typeParam TDoc Document / entity type this repository produces.
 */
export interface MinimalRepo<TDoc> {
  /**
   * Primary key field. Defaults to `'_id'` (Mongo convention) when omitted.
   * Arc reads this to decide whether route params pass straight through to
   * `update`/`delete` or translate via a fetched doc's `_id` first.
   */
  readonly idField?: string;

  /**
   * List with pagination. Kit auto-selects offset vs keyset based on the
   * presence of `page` vs `sort`/`after`. Return shapes all valid:
   *
   * - offset envelope when `page` is given
   * - keyset envelope when `sort` (+ optional `after`) is given
   * - raw array when neither drives pagination
   *
   * Arc's `BaseController` narrows the union before responding.
   */
  getAll(params?: PaginationParams<TDoc>, options?: QueryOptions): Promise<unknown>;

  /**
   * Fetch a single document by its primary key.
   *
   * **Miss semantics:** MAY return `null` or throw a 404-style error whose
   * message contains `"not found"`. Arc handles both. Pick one convention
   * and document it.
   */
  getById(id: string, options?: QueryOptions): Promise<TDoc | null>;

  /** Insert a single document. */
  create(data: Partial<TDoc>, options?: WriteOptions): Promise<TDoc>;

  /** Update by primary key. Returns the updated doc or null. */
  update(id: string, data: Partial<TDoc>, options?: WriteOptions): Promise<TDoc | null>;

  /**
   * Delete by primary key. Pass `{ mode: 'hard' }` to bypass soft-delete
   * interception (kits without soft-delete accept and ignore the flag).
   */
  delete(id: string, options?: DeleteOptions): Promise<DeleteResult>;
}

// ──────────────────────────────────────────────────────────────────────
// StandardRepo — the recommended surface
// ──────────────────────────────────────────────────────────────────────

/**
 * Recommended repository contract. Every method beyond `MinimalRepo` is
 * optional — kits implement what their backend can express. Arc
 * feature-detects at runtime.
 *
 * Kits targeting arc 2.10+ should aim for this shape. Everything beyond
 * (aggregate, bulkWrite, kit-specific builders, vector search) stays
 * kit-native.
 */
export interface StandardRepo<TDoc> extends MinimalRepo<TDoc> {
  /**
   * Atomic compare-and-set. Match one document, mutate it, return the
   * post-update doc (or pre-update when `returnDocument: 'before'`).
   * Returns `null` when no match and `upsert` is false.
   *
   * Required for arc's outbox, distributed-lock, and workflow-semaphore
   * patterns. Kits without atomic CAS should simulate it inside a
   * transaction — arc's stores assume single-round-trip semantics.
   *
   * **Update argument forms** (see {@link UpdateInput}):
   *
   *   1. `UpdateSpec` — portable IR built via `update({ set, unset, inc,
   *      setOnInsert })`. Every kit compiles this to its native shape.
   *      **Prefer this for portable code** (arc's infrastructure stores,
   *      plugins targeting multiple backends).
   *   2. `Record<string, unknown>` — kit-native raw record. mongokit
   *      treats this as a Mongo operator document (`$set`, `$inc`,
   *      `$unset`, ...). SQL kits treat it as flat column overwrites. Use
   *      for kit-specific fast paths.
   *   3. `Record<string, unknown>[]` — Mongo aggregation pipeline. Only
   *      mongokit executes this; SQL kits throw `UnsupportedOperationError`.
   *      Use for the rare cases where you need `$ifNull` / `$cond` /
   *      `$toLower` to preserve invariants atomically (e.g. outbox's
   *      `firstFailedAt`).
   *
   * Kits dispatch via `isUpdateSpec(update)` from `@classytic/repo-core/update`.
   */
  findOneAndUpdate?(
    filter: FilterInput,
    update: UpdateInput,
    options?: FindOneAndUpdateOptions,
  ): Promise<TDoc | null>;

  /**
   * Classify an error from a write as a unique-constraint violation.
   * Arc's idempotency + outbox adapters need this to distinguish
   * "already landed (idempotent no-op)" from "retry the write".
   *
   * Every backend signals duplicates differently (Mongo 11000, Prisma
   * P2002, Postgres 23505, SQLite UNIQUE constraint) — classification
   * lives in the kit that knows its driver.
   */
  isDuplicateKeyError?(err: unknown): boolean;

  // ── Compound read ────────────────────────────────────────────────────
  /** Find a single doc by compound filter (used by arc's AccessControl). */
  getOne?(filter: FilterInput, options?: QueryOptions): Promise<TDoc | null>;
  /** Alias many kits expose alongside `getOne`. Arc checks both names. */
  getByQuery?(filter: FilterInput, options?: QueryOptions): Promise<TDoc | null>;

  // ── Projections & existence ──────────────────────────────────────────
  count?(filter?: FilterInput, options?: QueryOptions): Promise<number>;
  exists?(filter: FilterInput, options?: QueryOptions): Promise<boolean | { _id: unknown } | null>;
  distinct?<T = unknown>(field: string, filter?: FilterInput, options?: QueryOptions): Promise<T[]>;
  findAll?(filter?: FilterInput, options?: QueryOptions): Promise<TDoc[]>;
  getOrCreate?(
    filter: FilterInput,
    data: Partial<TDoc>,
    options?: WriteOptions,
  ): Promise<TDoc | null>;

  // ── Batch ────────────────────────────────────────────────────────────
  createMany?(items: Partial<TDoc>[], options?: WriteOptions): Promise<TDoc[]>;

  /**
   * Apply the same update to every matching document. Required — every
   * `StandardRepo` kit must implement bulk update; arc's outbox,
   * idempotency, and cleanup stores depend on it. `data` accepts the
   * same three forms as {@link findOneAndUpdate}: portable `UpdateSpec`,
   * kit-native raw record, or Mongo aggregation pipeline (mongokit-only).
   *
   * **Promoted from optional to required in repo-core 0.2.0** — sqlitekit
   * and mongokit both ship this as a class primitive. Third-party kits
   * that previously omitted it now need to implement. Kits that lack a
   * native bulk-update primitive should fan out in a transaction.
   */
  updateMany(
    filter: FilterInput,
    data: UpdateInput,
    options?: WriteOptions,
  ): Promise<UpdateManyResult>;

  /**
   * Delete every document matching the filter. Required — symmetrically
   * with `updateMany`. Pass `{ mode: 'hard' }` to bypass soft-delete
   * interception; kits without soft-delete accept and ignore the flag.
   *
   * **Promoted from optional to required in repo-core 0.2.0.**
   */
  deleteMany(filter: FilterInput, options?: DeleteOptions): Promise<DeleteManyResult>;

  /**
   * Heterogeneous bulk write. Stays optional — kits dispatch each op
   * against the appropriate driver primitive inside a single transaction;
   * see each kit's docs for the exact semantics of `upsert` and
   * operator-shaped update values (mongokit honors `$set` etc., SQL kits
   * treat `update` as a flat column overwrite).
   *
   * Kept optional because the mongoose-shaped `BulkWriteOperation` has no
   * clean SQL analogue beyond "loop and dispatch" — forcing every kit to
   * implement it would push kits to ship a thin wrapper around updateMany
   * / deleteMany that offers nothing over calling them directly.
   */
  bulkWrite?(operations: readonly BulkWriteOperation<TDoc>[]): Promise<BulkWriteResult>;

  // ── Aggregation (portable IR) ────────────────────────────────────────

  /**
   * Portable aggregation. Compiles to `SELECT ... GROUP BY ...` on SQL
   * kits and to a `[$match, $group, $sort, $limit]` pipeline on mongokit.
   * Output shape (`{ rows }`) is identical across backends — dashboards
   * and admin tooling read the same result regardless of the driver.
   *
   * Distinct from kit-native aggregation APIs (mongokit's
   * `aggregatePipeline(stages)`, sqlitekit's raw `repo.db`) by design:
   * those take backend-specific inputs and return backend-specific
   * shapes, suited for joins / unwinds / window functions / CTEs. The
   * portable `aggregate` covers the filter + group + measures + sort +
   * limit subset that every backend supports — and nothing else, so
   * the behavior stays identical across drivers.
   */
  aggregate?<TRow extends AggRow = AggRow>(req: AggRequest): Promise<AggResult<TRow>>;

  /**
   * Paginated aggregation. Returns the standard offset envelope so UI
   * code paginates aggregated dashboards with the same primitives as
   * raw document lists. `countStrategy: 'none'` skips the distinct-
   * group count for infinite-scroll use.
   */
  aggregatePaginate?<TRow extends AggRow = AggRow>(
    req: AggPaginationRequest,
  ): Promise<OffsetPaginationResult<TRow>>;

  // ── Lookup / join (portable IR) ──────────────────────────────────────

  /**
   * Paginated join. Compiles the portable `LookupSpec[]` to `$lookup`
   * stages on mongokit or `LEFT JOIN` + `json_object()` / `json_group_array()`
   * on sqlitekit. Each returned row carries the base doc plus one key
   * per lookup's `as` (or `from` default). Output shape is identical
   * across backends — dashboards and detail views stop being kit-specific.
   *
   * Scope is deliberate: single-level joins keyed on `localField` /
   * `foreignField`. Pipeline-form `$lookup`, nested lookups, and
   * backend-specific join kinds stay on the kit-native path
   * (mongokit's `aggregatePipeline`, sqlitekit's raw Drizzle).
   */
  lookupPopulate?<TExtra extends Record<string, unknown> = Record<string, unknown>>(
    options: LookupPopulateOptions<TDoc>,
  ): Promise<LookupPopulateResult<TDoc, TExtra>>;

  // ── Soft delete ──────────────────────────────────────────────────────
  restore?(id: string, options?: QueryOptions): Promise<TDoc | null>;
  getDeleted?(params?: PaginationParams<TDoc>, options?: QueryOptions): Promise<unknown>;

  // ── Transactions ─────────────────────────────────────────────────────

  /**
   * Run `fn` inside a transaction. The callback receives a transaction-
   * bound repository (`txRepo`) — **call methods on `txRepo`, not on the
   * outer repo**, so SQL connection-scoped transactions and Prisma
   * client-scoped transactions actually contain the operations.
   *
   * For cross-kit consistency, SQL/Prisma kits return a rebound repo whose
   * internal driver points at the transaction. Mongokit's implementation
   * returns a proxy that threads `session` automatically — callers never
   * see the mongoose session directly.
   *
   * @example
   * ```ts
   * await repo.withTransaction?.(async (txRepo) => {
   *   const user = await txRepo.create({ name: 'Alice' });
   *   await txRepo.update(user.id, { role: 'admin' });
   * });
   * // Either both writes commit or neither does.
   * ```
   */
  withTransaction?<T>(
    fn: (txRepo: StandardRepo<TDoc>) => Promise<T>,
    options?: Record<string, unknown>,
  ): Promise<T>;
}
