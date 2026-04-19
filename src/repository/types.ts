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
 * delete, batch ops, transactions). Kits targeting arc 2.10+ should aim for
 * this shape. Everything beyond it (aggregate, bulkWrite, custom builders)
 * stays kit-specific — see each kit's docs.
 */

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
  filters?: Partial<TDoc> & Record<string, unknown>;
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
   */
  findOneAndUpdate?(
    filter: Record<string, unknown>,
    update: Record<string, unknown> | Record<string, unknown>[],
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
  getOne?(filter: Record<string, unknown>, options?: QueryOptions): Promise<TDoc | null>;
  /** Alias many kits expose alongside `getOne`. Arc checks both names. */
  getByQuery?(filter: Record<string, unknown>, options?: QueryOptions): Promise<TDoc | null>;

  // ── Projections & existence ──────────────────────────────────────────
  count?(filter?: Record<string, unknown>, options?: QueryOptions): Promise<number>;
  exists?(
    filter: Record<string, unknown>,
    options?: QueryOptions,
  ): Promise<boolean | { _id: unknown } | null>;
  distinct?<T = unknown>(
    field: string,
    filter?: Record<string, unknown>,
    options?: QueryOptions,
  ): Promise<T[]>;
  findAll?(filter?: Record<string, unknown>, options?: QueryOptions): Promise<TDoc[]>;
  getOrCreate?(
    filter: Record<string, unknown>,
    data: Partial<TDoc>,
    options?: WriteOptions,
  ): Promise<TDoc | null>;

  // ── Batch ────────────────────────────────────────────────────────────
  createMany?(items: Partial<TDoc>[], options?: WriteOptions): Promise<TDoc[]>;
  updateMany?(
    filter: Record<string, unknown>,
    data: Record<string, unknown>,
    options?: WriteOptions,
  ): Promise<UpdateManyResult>;
  deleteMany?(filter: Record<string, unknown>, options?: DeleteOptions): Promise<DeleteManyResult>;

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
