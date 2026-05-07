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
import type { LookupPopulateOptions, LookupPopulateResult, LookupSpec } from '../lookup/types.js';
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

/**
 * Transition spec for `StandardRepo.claim()` — a CAS state change.
 *
 * Most state machines key off a `status` field (the default), so the
 * common shape is just `{ from, to }`. Use the `field` key when the
 * state lives on a different column (`phase`, `state`, `step`, etc.).
 *
 * For state machines whose "ready to claim" predicate isn't expressible
 * by the state field alone — paused guards, retry-time guards,
 * heartbeat-staleness, sub-document `$elemMatch` predicates — see the
 * `where` field below.
 *
 * **Cross-package stability contract.** This shape is the canonical
 * source of truth that mongokit's `Repository.claim`, sqlitekit's
 * `claim`, and primitives' `ClaimableRepo<TDoc>` (in
 * `@classytic/primitives/state-machine`) ALL conform to. Primitives
 * stays dep-free by mirroring this shape structurally with
 * `Record<string, unknown>` for the options slot — kits implement it
 * with their own option-bag refinements (mongokit's `SessionOptions
 * & { idField?, upsert? }`, sqlitekit's analogous shape) which remain
 * structurally compatible.
 *
 * Editors: changing field names, removing slots, or narrowing
 * existing parameter types here is a contract-level break. Adding
 * new optional fields is additive — fine. The conformance test in
 * mongokit's `tests/unit/standard-repo-assignment.test-d.ts`
 * (wired into `prepublishOnly`) catches drift at the kit boundary.
 */
export interface ClaimTransition {
  /**
   * Document field carrying the state. Defaults to `'status'` —
   * matches the convention across `streamline`, `@classytic/order`,
   * `revenue`, and `invoice` packages.
   */
  field?: string;
  /**
   * Required current value of the state field for the CAS to match.
   *
   * **Single value or array.** Pass a literal (`from: 'pending'`) for a
   * single-source transition, or an array (`from: ['pending',
   * 'approved']`) when the transition is legal from multiple states —
   * compiles to `[field]: { $in: [...] }` on mongokit and
   * `[field] IN (?, ?, ...)` on SQL kits. Real-world frequency:
   * commission has 4 sites (`voidRecord`, `markClawedBack`,
   * `endAgreement`, `_transition`) keyed off multi-source transitions;
   * media-kit's error path catches failures from either `pending` or
   * `processing`. Without array support these sites fall back to raw
   * `findOneAndUpdate` and lose the ergonomic + plugin-routed claim
   * benefits.
   *
   * **`from === to` is allowed** — idempotent re-claim with a payload
   * write is a valid pattern (yard's `reviseDeparture` writes
   * `departed → departed` to update fields atomically while asserting
   * the row hasn't moved on). The CAS still returns `null` if the row
   * left the source state, so race-loss semantics hold.
   *
   * **Upsert + array from:** when `upsert: true` is set on the call
   * options and `from` is an array, mongo / SQL kits skip the literal-
   * value insert behavior for that field — only a literal `from`
   * value lands on the inserted row. Use a literal `from` if you need
   * the inserted row to carry that source-state value (rare).
   */
  from: unknown | readonly unknown[];
  /**
   * Target value written to the state field on success. Always a
   * literal — claim writes one target value per call.
   */
  to: unknown;
  /**
   * Additional filter predicates AND-merged into the CAS query
   * alongside `{ [idField]: id, [field]: from }`. Use for guards
   * the state field alone can't express. NOTE: this is the same
   * `where` slot supported on `ClaimVersionTransition`.
   *
   *   - `{ paused: { $ne: true } }` — skip paused docs
   *   - `{ retryAfter: { $lte: now } }` — only fire when the timer
   *     elapsed
   *   - `{ $or: [{ lastHeartbeat: { $lt: stale } }, ...] }` —
   *     heartbeat-staleness, multi-condition match
   *   - `{ steps: { $elemMatch: { status: 'pending' } } }` —
   *     sub-document predicates
   *
   * Real-world data: of streamline's 21 atomic-claim sites, only 1
   * fits the bare `{ [idField]: id, [field]: from }` shape; the
   * other 20 carry compound predicates of exactly this shape. Same
   * pattern across `revenue`, `order`, `invoice`. Without this field,
   * `claim` covers the textbook example but misses every real-world
   * state machine in the ecosystem.
   *
   * Null-on-race semantics unchanged: if no doc matches the full
   * compound filter (state field OR any `where` predicate), `claim`
   * returns `null`. The caller can't distinguish "lost race" from
   * "guard predicate failed" — both mean "don't proceed."
   *
   * Cross-kit notes:
   *   - Mongokit: ANDed into the `findOneAndUpdate` filter.
   *   - SQL kits: ANDed into the `WHERE` clause (raw column literals
   *     accepted; portable Filter IR is compiled).
   *   - Prismakit: merged as additional keys on the `where` object.
   */
  where?: Record<string, unknown>;
}

/**
 * Transition spec for `StandardRepo.claimVersion()` — optimistic-
 * concurrency CAS via a version stamp. Sibling to `ClaimTransition`;
 * different mental model:
 *
 *   - `claim` is a state machine: "move from status A to status B,
 *     atomically".
 *   - `claimVersion` is optimistic locking: "I expect version N; if
 *     it still is, apply this update and bump the version".
 *
 * The CAS round-trip:
 *
 * ```ts
 * findOneAndUpdate(
 *   { _id, [versionField]: from, ...where },          // CAS match
 *   { ...update, $inc: { [versionField]: by ?? 1 } }, // bump on success
 * );
 * ```
 *
 * Returns `null` when the row is missing, the version doesn't match
 * (race-loss), or any `where` predicate fails. Same null-on-race
 * semantics as `claim`.
 */
export interface ClaimVersionTransition {
  /**
   * Field carrying the version stamp. Defaults to `'version'` —
   * matches the convention across `@classytic/order`, `leave`,
   * `payrun`.
   */
  field?: string;
  /**
   * Required current value of the version field for the CAS to
   * match. **`undefined` is admitted** for first-write CAS — matches
   * docs whose version field is missing OR null. Lean reads return
   * `version: number | undefined` because field defaults are absent
   * on fresh-from-DB POJOs; tolerating `undefined` removes the
   * `?? 0` ceremony at every call site. The implementation
   * initializes via `$set` on the first-write path (since `$inc`
   * can't apply to a null-valued field on mongo).
   */
  from: number | undefined;
  /**
   * Increment step. Defaults to `1`. Use `by: -1` for unusual
   * decrement-on-CAS patterns; not common.
   */
  by?: number;
  /**
   * Additional filter predicates AND-merged into the CAS query
   * alongside `{ [idField]: id, [versionField]: from }`. Same
   * compound-CAS semantic as `ClaimTransition.where` — paused
   * guards, status guards (yard's `{ _id, status, version }`
   * pattern), sub-document `$elemMatch`. Without this, callers had
   * to fall back to raw `findOneAndUpdate` for state+version CAS.
   */
  where?: Record<string, unknown>;
}

// ──────────────────────────────────────────────────────────────────────
// Result envelopes
// ──────────────────────────────────────────────────────────────────────

/**
 * Result of a single delete — what the kit returns AND what the wire
 * emits (data and wire shapes are identical, like the pagination types).
 *
 * Miss handling is `null` (matches `update()`, `Map.get`, `Array.find`
 * conventions) — kits return `Promise<DeleteResult | null>`. Callers
 * check `if (!result)` for "nothing was deleted".
 */
export interface DeleteResult {
  message: string;
  /** Primary key of the removed doc (string form). */
  id?: string;
  /** True when a soft-delete plugin intercepted the operation. */
  soft?: boolean;
  /** For batch-variant implementations that surface the count inline. */
  count?: number;
}

/**
 * Result of a bulk create — what kits return from `createMany()` AND
 * what the wire emits. `data` is the inserted docs (kits may omit when
 * caller passed `returnDocs: false`); `count` is the number successfully
 * inserted.
 */
export interface BulkCreateResult<T = unknown> {
  data?: T[];
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
/**
 * Optional per-measure predicate. When set, the measure aggregates
 * ONLY over rows matching the predicate within each group — semantic
 * equivalent of SQL's `SUM(amount) FILTER (WHERE status = 'paid')`
 * and Mongo's `{ $sum: { $cond: [<expr>, '$amount', 0] } }`.
 *
 * Lets one query compute `paid_revenue` + `total_revenue` +
 * `refund_count` side-by-side, instead of running N pre-filtered
 * pipelines and stitching the rows together at the call site. The
 * #1 dashboard-query lever; cuts query count + DB load proportional
 * to the number of distinct slices in a typical KPI tile group.
 *
 * Accepts the same `FilterInput` shape every other slot does (Filter
 * IR or plain record). References BASE columns + joined-alias paths
 * (when `lookups` are configured), same as the top-level `filter`.
 *
 * Does NOT replace the top-level `AggRequest.filter` — that narrows
 * the rows feeding into ALL measures; per-measure `where` narrows
 * within the group AFTER the top-level filter has already applied.
 *
 * @example
 * ```ts
 * await orders.aggregate({
 *   groupBy: 'category',
 *   measures: {
 *     totalRevenue: { op: 'sum', field: 'amount' },
 *     paidRevenue:  { op: 'sum', field: 'amount', where: eq('status', 'paid') },
 *     refundCount:  { op: 'count', where: eq('status', 'refunded') },
 *   },
 * });
 * ```
 */
export type AggMeasure =
  | { op: 'count'; field?: string; where?: FilterInput }
  | { op: 'countDistinct'; field: string; where?: FilterInput }
  | { op: 'sum'; field: string; where?: FilterInput }
  | { op: 'avg'; field: string; where?: FilterInput }
  | { op: 'min'; field: string; where?: FilterInput }
  | { op: 'max'; field: string; where?: FilterInput }
  | {
      /**
       * Continuous percentile — interpolates between adjacent values
       * when the requested rank falls between two rows. Equivalent to
       * SQL's `PERCENTILE_CONT(p) WITHIN GROUP (ORDER BY field)` and
       * Mongo's `$percentile` with `method: 'approximate'` (Mongo 7+).
       *
       * `p` is the percentile in `[0, 1]` (e.g. `0.5` for median,
       * `0.95` for P95 latency).
       *
       * **Kit support is asymmetric.** Mongokit (≥3.13) maps to
       * `$percentile`; sqlitekit throws `UnsupportedOperationError`
       * (SQLite has no native percentile function and emulating via
       * window functions is approximate + slow). Hosts targeting
       * percentile dashboards pin to a backend that supports it
       * (mongokit, future pgkit's `PERCENTILE_CONT`).
       */
      op: 'percentile';
      field: string;
      p: number;
      where?: FilterInput;
    }
  | {
      /**
       * Sample standard deviation — `sqrt(variance / (n - 1))`.
       * Equivalent to SQL's `STDDEV_SAMP()` and Mongo's
       * `$stdDevSamp`. Use `'stddevPop'` for population stddev
       * (`/ n` instead of `/ (n - 1)`); pick `'stddev'` (sample) by
       * default — that's what every BI tool reports without
       * qualification, and matches `numpy.std(ddof=1)`.
       *
       * **Kit support is asymmetric.** Mongokit uses native
       * `$stdDevSamp` (numerically stable Welford algorithm).
       * Sqlitekit throws `UnsupportedOperationError` — SQLite ships
       * no native `STDDEV` aggregate and emulating via the
       * computational formula `sqrt(sum(x²) - sum(x)²/n / (n-1))`
       * is numerically unstable for typical dashboard data
       * (catastrophic cancellation when values are near-equal). Hosts
       * needing stddev dashboards pin to mongokit or future pgkit.
       */
      op: 'stddev';
      field: string;
      where?: FilterInput;
    }
  | {
      /** Population standard deviation (`/ n`). See `'stddev'` for
       * the sample variant + per-kit support matrix (identical). */
      op: 'stddevPop';
      field: string;
      where?: FilterInput;
    };

/**
 * Tie-breaking strategy for `AggTopN.ties`. Mirrors the three SQL
 * window-rank functions; mongokit maps the same names to
 * `$rank` / `$denseRank` / `$documentNumber`.
 *
 *   - `'rank'`        — `RANK()`. Ties share a rank; gaps after.
 *                        e.g. `[100, 100, 80] → ranks 1, 1, 3`.
 *   - `'dense_rank'`  — `DENSE_RANK()`. Ties share a rank; no gaps.
 *                        e.g. `[100, 100, 80] → ranks 1, 1, 2`.
 *   - `'row_number'`  — `ROW_NUMBER()`. Each row gets a unique rank
 *                        regardless of ties; tie-broken arbitrarily.
 *                        e.g. `[100, 100, 80] → ranks 1, 2, 3`.
 *
 * Default: `'rank'`. Choose `'row_number'` when you need EXACTLY N
 * rows per partition with no chance of overshoot from ties.
 */
export type AggTopNTies = 'rank' | 'dense_rank' | 'row_number';

/**
 * Top-N-per-group spec — keep only the top `limit` rows per
 * partition, ranked by `sortBy`. The classic "top 3 products per
 * category" / "top 5 customers per region" dashboard primitive.
 *
 * **Semantics.** Each unique combination of `partitionBy` columns
 * forms a partition. Within each partition, rows are ranked by
 * `sortBy` (descending by default — typical "top N" intent). The
 * top `limit` rows from each partition land in the result; the rest
 * are dropped.
 *
 * **Compile target.**
 *
 *   - **Mongokit** — `$setWindowFields` + `$match: { rank: { $lte: limit } }`.
 *     Mongo 5+. The window stage runs AFTER `$group` / `$project`,
 *     so `partitionBy` and `sortBy` may reference both group keys
 *     and measure aliases.
 *   - **Sqlitekit** — `RANK() / DENSE_RANK() / ROW_NUMBER() OVER
 *     (PARTITION BY ... ORDER BY ...)` wrapped in a subquery, with
 *     a `WHERE rank <= limit` outer filter. SQLite ≥3.25 (Sept 2018).
 *
 * **Cross-kit shape contract.** The output row shape doesn't change
 * — top-N just drops rows that didn't make the cut. Internal rank
 * column is stripped before the row reaches the caller.
 *
 * @example "Top 3 products per category by revenue"
 * ```ts
 * await orders.aggregate({
 *   groupBy: ['category', 'product'],
 *   measures: { revenue: { op: 'sum', field: 'amount' } },
 *   topN: {
 *     partitionBy: 'category',
 *     sortBy: { revenue: -1 },
 *     limit: 3,
 *   },
 *   sort: { category: 1, revenue: -1 },
 * });
 * ```
 *
 * @example "Top 1 highest spender per region per month"
 * ```ts
 * await orders.aggregate({
 *   dateBuckets: { month: { field: 'createdAt', interval: 'month' } },
 *   groupBy: ['region', 'customerId'],
 *   measures: { spent: { op: 'sum', field: 'amount' } },
 *   topN: {
 *     partitionBy: ['region', 'month'],
 *     sortBy: { spent: -1 },
 *     limit: 1,
 *     ties: 'row_number',  // exactly one winner per partition
 *   },
 * });
 * ```
 */
export interface AggTopN {
  /**
   * Group columns or `dateBuckets` aliases that define each partition.
   * Must be a subset of `groupBy` + `dateBuckets` keys — kits validate
   * at compile time and throw on a mismatch.
   *
   * Pass a single string for a one-column partition; an array for
   * compound partitions.
   */
  partitionBy: string | readonly string[];
  /**
   * Ranking sort within each partition. Keys are measure aliases,
   * `groupBy` columns, or `dateBuckets` aliases — the same surface
   * as the top-level `sort`. Defaults to descending intent (top N
   * by revenue → `{ revenue: -1 }`).
   */
  sortBy: Record<string, 1 | -1>;
  /** Max rows to keep per partition. Must be a positive integer. */
  limit: number;
  /**
   * Tie-breaking strategy. Default `'rank'`. See `AggTopNTies` for
   * the three options.
   */
  ties?: AggTopNTies;
}

/**
 * Per-request cache options for `aggregate()` / `aggregatePaginate()`.
 *
 * **Unified with the canonical `CacheOptions`** at `@classytic/repo-core/cache`.
 * Same shape across CRUD, aggregate, and every kit — TanStack Query-
 * inspired `staleTime` / `gcTime` model, `swr` flag, `tags` for group
 * invalidation, `bypass` for refresh buttons, `enabled` for opt-out,
 * `key` for explicit override.
 *
 * Kept here as a re-export so existing `import { AggCacheOptions }`
 * paths keep working — they resolve to the same type.
 */
export type AggCacheOptions = import('../cache/options.js').CacheOptions;

/**
 * Driver-tunable knobs forwarded to the kit's native aggregation API.
 * Each kit honors the hints it can; unsupported keys are ignored
 * (never thrown) — keeps the IR portable while letting hosts opt into
 * backend-specific performance levers without dropping to kit-native
 * pipelines.
 *
 * **Per-kit support matrix:**
 *
 * | Hint            | mongokit                       | sqlitekit                | future kits |
 * | --------------- | ------------------------------ | ------------------------ | ----------- |
 * | `allowDiskUse`  | `aggregate({ allowDiskUse })`  | ignored (planner spills) | per-driver  |
 * | `maxTimeMs`     | `aggregate({ maxTimeMS })`     | ignored (sync driver)    | per-driver  |
 * | `indexHint`     | `aggregate({ hint })`          | ignored (planner-driven) | per-driver  |
 *
 * **Hosts that need a hint to work** must pin the kit version that
 * supports it via peer-deps. Falling back to "ignored" keeps mixed-
 * kit fleets working — if a sqlitekit user asks for `allowDiskUse`,
 * they get the same query they would have without it (SQLite's
 * planner spills to disk automatically).
 *
 * **Why sqlitekit ignores `maxTimeMs`:** better-sqlite3 (the reference
 * driver) is synchronous — there is no event-loop tick during a query
 * for a watchdog to interrupt. `db.pragma('busy_timeout', n)` is a
 * connection-level wait-for-lock setting, NOT a query timeout, and is
 * already configured at driver init. For workloads that need
 * cancellable queries pin to mongokit / pgkit, or run sqlitekit on
 * libsql (async driver) where statement-level abort is feasible.
 */
export interface AggExecutionHints {
  /**
   * Allow the aggregation to spill intermediate results to disk when
   * the in-memory limit is exceeded. Mongo: `allowDiskUse: true`.
   * SQL: typically a no-op (the query planner already manages spill).
   */
  allowDiskUse?: boolean;
  /**
   * Server-side query timeout in milliseconds. Mongo: `maxTimeMS`.
   * Aborted queries throw a kit-native timeout error — wire it to
   * your error handler if you want graceful degradation.
   */
  maxTimeMs?: number;
  /**
   * Index hint passed to the planner. Kit-specific shape:
   * mongokit accepts `{ field: 1 }` or an index name string;
   * sqlitekit ignores (the SQLite planner picks indexes itself).
   * Use sparingly — most aggregations plan correctly without hints.
   */
  indexHint?: unknown;
}

/**
 * Time-unit primitive for bucket sizing. Use `AggDateBucketInterval`
 * (the union below) at API boundaries — this type is the underlying
 * unit set both the named buckets (`'month'`) and the custom-bin
 * shape (`{ every: 15, unit: 'minute' }`) draw from.
 */
export type AggDateBucketUnit = 'minute' | 'hour' | 'day' | 'week' | 'month' | 'quarter' | 'year';

/**
 * Granularity for time-bucket grouping. Two surface forms:
 *
 * 1. **Named buckets** — string-shape, emit canonical ISO-shaped labels:
 *
 *   - `'minute'`  → `'YYYY-MM-DDTHH:MM'`  (`'2026-04-15T10:30'`)
 *   - `'hour'`    → `'YYYY-MM-DDTHH:00'`  (`'2026-04-15T10:00'`)
 *   - `'day'`     → `'YYYY-MM-DD'`        (`'2026-04-15'`)
 *   - `'week'`    → `'YYYY-Www'`          (`'2026-W15'`, ISO 8601 week)
 *   - `'month'`   → `'YYYY-MM'`           (`'2026-04'`)
 *   - `'quarter'` → `'YYYY-Qn'`           (`'2026-Q2'`)
 *   - `'year'`    → `'YYYY'`              (`'2026'`)
 *
 * 2. **Custom bins** — object-shape, for arbitrary intervals like
 *    "every 15 minutes" or "every 6 hours":
 *
 *   ```ts
 *   { every: 15, unit: 'minute' }   // 00:00, 00:15, 00:30, ...
 *   { every: 6,  unit: 'hour'   }   // 00:00, 06:00, 12:00, ...
 *   { every: 7,  unit: 'day'    }   // weekly bins anchored on epoch
 *   ```
 *
 *    Custom bins emit ISO-shaped labels matching the largest unit
 *    granularity that disambiguates the bin start (e.g. 15-minute bins
 *    emit `'YYYY-MM-DDTHH:MM'`; 6-hour bins emit `'YYYY-MM-DDTHH:00'`).
 *    `every` must be a positive integer; `unit` is the same set as
 *    named buckets minus quarter (which only makes sense as `every: 1`).
 *
 *  **All bucketing is UTC.** Kits that need wall-clock semantics for
 *  "this month in America/Los_Angeles" pre-shift the column at the
 *  application layer — keeping the IR timezone-free dodges per-kit
 *  tz library mismatches (mongo's `$dateToString` and SQLite's
 *  `strftime` use different IANA tables).
 *
 *  The bucket label is sortable lexicographically — that's the whole
 *  point of the format. `ORDER BY month ASC` yields chronological
 *  order without parsing the string back into a date.
 */
export type AggDateBucketInterval =
  | AggDateBucketUnit
  | {
      /** Number of `unit`-sized chunks per bin. Must be a positive integer. */
      every: number;
      /** Base unit. `quarter` and `year` aren't supported in custom-bin form. */
      unit: Exclude<AggDateBucketUnit, 'quarter' | 'year'>;
    };

/**
 * Time-bucket group expression. Promotes a date column into a
 * synthetic group key bucketed by the chosen interval.
 *
 * **Why a separate slot, not inline in `groupBy`.** A computed
 * expression isn't a column reference. Each kit needs the
 * `field + interval` pair to emit its dialect (`$dateToString` on
 * Mongo, `strftime` on SQLite, `DATE_TRUNC` on PG). Keeping it on its
 * own slot lets `groupBy` stay a plain column-name list — no shape
 * change for existing callers.
 *
 * The bucket alias (the key in `dateBuckets`) becomes a regular group
 * key — it counts as a `groupBy` participant for cardinality, sort,
 * and pagination. Reference it in `having` / `sort` by alias.
 *
 * @example
 * ```ts
 * await orders.aggregate({
 *   filter: { status: 'paid' },
 *   dateBuckets: { month: { field: 'createdAt', interval: 'month' } },
 *   measures: { revenue: { op: 'sum', field: 'amount' } },
 *   sort: { month: 1 },
 * });
 * // rows: [
 * //   { month: '2026-01', revenue: 12345 },
 * //   { month: '2026-02', revenue: 18900 },
 * // ]
 * ```
 */
export interface AggDateBucket {
  /**
   * The date / timestamp column to bucket. May be a dotted path into a
   * joined alias when `lookups` is configured.
   *
   * **Storage shape kits must accept:** ISO-8601 strings (the canonical
   * cross-kit shape from arc + kit serializers), millisecond epoch
   * numbers, and native Date / BSON Date values. SQLite's TEXT-stored
   * timestamps in `'YYYY-MM-DD HH:MM:SS'` form also work.
   */
  field: string;
  /** Bucket granularity. */
  interval: AggDateBucketInterval;
}

/**
 * Portable aggregation request. Compiles to SQL (`SELECT ... FROM ...
 * [LEFT JOIN ...] WHERE ... GROUP BY ... HAVING ... ORDER BY ... LIMIT ...
 * OFFSET`) on sqlitekit / pgkit and to a `[$match, $lookup*, $group,
 * $match, $sort, $limit, $skip]` pipeline on mongokit. Output shape is
 * identical either way: one row per group, keyed by `groupBy` fields
 * + measure aliases.
 *
 * Without `groupBy`: returns a single row of scalar aggregates over the
 * full filtered set. With `groupBy`: one row per distinct group.
 *
 * **Compile order (every kit MUST follow):**
 *
 *   1. `filter`   — pre-aggregate predicate, applied to BASE rows
 *                   BEFORE joins. Drives index selection. (WHERE / `$match`)
 *   2. `lookups`  — joins, processed in array order. Each `LookupSpec`
 *                   contributes one stage. Joined rows land at the
 *                   alias declared in `LookupSpec.as` (or `from` when
 *                   `as` omitted).
 *   3. `groupBy`  — one row per distinct combination of group keys.
 *                   May reference dotted paths into joined aliases:
 *                   `'category.parent'` groups by the joined
 *                   `category` row's `parent` field.
 *   4. `measures` — aggregate functions applied to the grouped rows.
 *                   `measure.field` accepts the same dotted-path syntax
 *                   as `groupBy` for joined fields.
 *   5. `having`   — post-aggregate predicate, references measure
 *                   aliases. (HAVING)
 *   6. `sort`     — order grouped rows. Keys are `groupBy` fields,
 *                   measure aliases, or dotted paths into joined rows.
 *   7. `limit` / `offset` — row cap + skip.
 *
 * **Filter IR usage:** `filter` and `having` both reuse the Filter IR.
 * `filter` narrows the rows that feed into the aggregate; `having`
 * narrows the aggregated result. Reference measure aliases in `having`
 * (`{ field: 'revenue', op: 'gt', value: 1000 }`) — kit compilers
 * substitute the aggregate expression when the field matches a measure.
 *
 * **Tenant / policy filter alignment.** Hosts (or arc) MUST inject
 * tenant-scope predicates as the LEFT-MOST clause of `filter` so the
 * leading-key index is hit first. Order matters at scale: an
 * unscoped aggregate on a billion-row collection scans the world.
 *
 * **Power features that stay kit-native.** Window functions, CTEs,
 * pipeline-form `$lookup` with `let`, sub-aggregations, lateral
 * correlated subqueries — reach for `aggregatePipeline` (mongokit) or
 * raw Drizzle (`repo.db`) (sqlitekit). The portable IR draws a
 * deliberate ceiling at "joins + grouping + measures."
 */
export interface AggRequest {
  /** Pre-aggregate predicate on the BASE rows (before joins). Reuses
   * Filter IR; compiles to WHERE / `$match`. Place tenant-scope
   * predicates first for correct index selection. */
  filter?: unknown;

  /**
   * Optional cross-table joins. Compiled BEFORE the grouping pipeline
   * so `groupBy` / `measure.field` / `having` / `sort` may reference
   * `joinedAlias.field` paths. Reuses the same `LookupSpec` IR that
   * `lookupPopulate()` accepts — kits that already ship
   * `lookupPopulate` reuse their compile path (mongokit emits
   * `$lookup` stages, sqlitekit emits `LEFT JOIN`).
   *
   * **Per-lookup `where`** narrows the foreign side BEFORE the join
   * runs. Always set when joining a high-cardinality table — without
   * it, you join the world and post-filter, which doesn't scale.
   *
   * **Per-lookup `select`** projects only required columns from the
   * joined row. Reduces row size and prevents accidental exposure of
   * sensitive fields on the joined side.
   *
   * **Kit support is graceful-fail.** A kit that doesn't support
   * `lookups` in its `aggregate()` throws an
   * `UnsupportedOperationError` with a clear message at request time.
   * Hosts pin their kit version via peer-deps to get the support
   * window they need.
   */
  lookups?: readonly LookupSpec[];

  /** Grouping columns. Single string, array of strings, or omitted for
   * scalar aggregation. May reference dotted paths into joined aliases
   * when `lookups` is present (e.g. `'category.parent'`). */
  groupBy?: string | readonly string[];

  /**
   * Synthetic time-bucket group keys. Each entry promotes a date
   * column into a group key bucketed at the chosen granularity
   * (`day` / `week` / `month` / `quarter` / `year`). The map key
   * becomes a column in the output row holding the canonical
   * ISO-shaped bucket label.
   *
   * Bucketed keys participate in grouping just like `groupBy` columns
   * — `sort: { month: 1 }`, `having: { field: 'month', op: 'gte', ... }`,
   * pagination cardinality all treat them as first-class.
   *
   * Aliases must NOT collide with `groupBy` field names or `measures`
   * aliases — the row shape would be ambiguous. Kits surface a
   * collision as a runtime error.
   */
  dateBuckets?: Record<string, AggDateBucket>;

  /**
   * Named aggregations. At least one key required — an empty `measures`
   * bag is a wiring bug (nothing to compute). `measure.field` accepts
   * the same dotted-path syntax as `groupBy` for joined fields.
   */
  measures: Record<string, AggMeasure>;

  /** Post-aggregate predicate. Reuses Filter IR; references measure aliases. */
  having?: unknown;

  /** Order the grouped rows. Keys may be `groupBy` fields, measure
   * aliases, or dotted paths into joined rows. */
  sort?: Record<string, 1 | -1>;

  /** Row cap; applied after `having` + `sort`. */
  limit?: number;

  /** Skip N grouped rows. Paginated callers use `aggregatePaginate` instead. */
  offset?: number;

  /**
   * Top-N-per-group filter. Keeps only the top `limit` rows per
   * partition, ranked by `sortBy`. See `AggTopN` for full semantics.
   *
   * Composes with everything else — applies AFTER group / measures /
   * having so `sortBy` may reference measure aliases. Composes with
   * the top-level `sort` (which orders the FINAL row set, not within
   * each partition).
   */
  topN?: AggTopN;

  /**
   * Driver-tunable performance knobs (allowDiskUse, maxTimeMs,
   * indexHint). See `AggExecutionHints` for the per-kit support
   * matrix. Hints a kit doesn't support are silently ignored — the
   * IR stays portable while letting hosts opt into backend-specific
   * levers without dropping to kit-native pipelines.
   */
  executionHints?: AggExecutionHints;

  /**
   * Per-request cache options (TTL, tags, bypass, SWR). See
   * `AggCacheOptions` for full semantics. Caching is **opt-in per
   * call** — omit this slot (or set `ttl: 0`) and the request
   * bypasses the cache layer entirely. Requires the repo to have a
   * `CacheAdapter` configured (`new Repository(model, plugins, {},
   * { aggregateCache: adapter })`); throws at request time when
   * caching is requested but no adapter is wired.
   */
  cache?: AggCacheOptions;
}

/**
 * Paginated variant of `AggRequest`. Two pagination modes are
 * supported, picked by which fields are set:
 *
 * - **Offset** (default) — pass `page` (1-indexed) + `limit`. Returns
 *   the canonical offset envelope (`{ method: 'offset', data, total,
 *   pages, hasNext, hasPrev, page, limit }`). Same shape as
 *   `getAll({ page, limit })` so UI code renders aggregates and raw
 *   document lists with the same pagination primitives.
 *
 * - **Keyset** — pass `pagination: 'keyset'` (or supply `after`).
 *   Cursor-based: each response returns an opaque `next` token that
 *   the caller passes back as `after` to fetch the following page.
 *   `sort` is required (the cursor encodes the sort-key tuple of the
 *   last row); aliases referenced in `sort` must be either
 *   `groupBy` columns, `dateBuckets` aliases, or `measures` aliases.
 *
 * Keyset pagination scales to arbitrary group counts because it never
 * scans skipped rows — `WHERE (k1, k2) > (a, b)` uses the
 * `groupBy + sort` index path. Offset's `OFFSET N` skip is O(N), so it
 * stalls past ~10–100k groups even with the right index. Reach for
 * keyset on dashboards with deep result sets, infinite-scroll UI, and
 * any time `total` doesn't have to render.
 *
 * ## Index requirements (don't skip this for big-data workloads)
 *
 * The keyset advantage **vanishes without the right index**. The
 * compiled query is:
 *
 * ```sql
 * SELECT ...groupCols, ...measures
 * FROM <table>
 * WHERE <filter>
 * GROUP BY <groupCols>
 * HAVING (sortKey1, sortKey2, ...) > (?, ?, ...)   -- cursor predicate
 * ORDER BY <sortKey1, sortKey2>
 * LIMIT <pageSize>
 * ```
 *
 * On large tables (10M+ rows) you MUST have:
 *
 * 1. **A composite index covering `filter` columns + `groupBy` columns**
 *    in roughly that order. Without this, every page rescans the base
 *    table — the cursor predicate runs on the post-`GROUP BY` set, so
 *    if grouping itself is a full scan, keyset gives no advantage over
 *    offset.
 *
 * 2. **Sort keys aligned with the index leftmost prefix.** When `sort`
 *    is on a measure alias (e.g. `revenue desc`), no index can help —
 *    the engine must compute every group before sorting. Such sorts
 *    are O(N log N) per page even with keyset; consider materializing
 *    the aggregate into a roll-up table and paginating that instead.
 *
 * **Examples** (mongokit / Mongo dialect; sqlitekit takes the same
 * shape via Drizzle schema indexes):
 *
 * ```ts
 * // groupBy: ['organizationId', 'category']  +  sort: { category: 1 }
 * Schema.index({ organizationId: 1, category: 1 });
 *
 * // filter: { active: true } + groupBy: ['userId'] + sort: { userId: 1 }
 * Schema.index({ active: 1, userId: 1 });
 *
 * // dateBuckets: { day: { field: 'createdAt', unit: 'day' } }
 * //   + sort: { day: -1 } — cursor compares on the bucket expression,
 * // so the index must cover `createdAt` (the planner pushes the bucket
 * // through to a range scan):
 * Schema.index({ createdAt: -1 });
 * ```
 *
 * If `EXPLAIN` shows a `COLLSCAN` / `SCAN TABLE` on a keyset query,
 * your index is missing or in the wrong order. Mongo's
 * `db.coll.aggregate(...).explain('executionStats')` and SQLite's
 * `EXPLAIN QUERY PLAN` both surface this.
 */
export interface AggPaginationRequest extends Omit<AggRequest, 'limit' | 'offset'> {
  /** Rows per page. Defaults to the kit's standard limit. */
  limit?: number;
  /**
   * Pagination mode. `offset` (default) returns
   * `{ method: 'offset', ... }`; `keyset` returns
   * `{ method: 'keyset', ... }`. Setting `after` implies `'keyset'`.
   */
  pagination?: 'offset' | 'keyset';
  /** 1-indexed page number. Used by `offset` mode only. Defaults to 1. */
  page?: number;
  /**
   * `exact` runs `COUNT(DISTINCT groupBy)` (or `COUNT(*)` for scalar
   * aggregates) alongside the data query. `none` skips the count
   * entirely — the envelope's `total` / `pages` are 0 and `hasNext` is
   * derived from a `LIMIT N+1` peek. Defaults to `exact`. Used by
   * `offset` mode only — `keyset` never runs a count.
   */
  countStrategy?: 'exact' | 'none';
  /**
   * Opaque cursor from a prior keyset response's `next` field. When
   * set, returns the page following the row identified by the cursor.
   * Implies `pagination: 'keyset'`.
   *
   * Format is kit-defined and opaque — consumers MUST round-trip it
   * verbatim. Cross-kit cursor compatibility is not guaranteed.
   */
  after?: string;
}

/**
 * Keyset-paginated aggregation envelope. Returned by
 * `aggregatePaginate(req)` when `pagination: 'keyset'` (or `after` is
 * set). Mirrors the keyset shape `MinimalRepo.getAll()` produces for
 * raw doc lists, so UI components can branch on `method` once and
 * render either case identically.
 */
export interface KeysetAggPaginationResult<TRow extends AggRow = AggRow> {
  method: 'keyset';
  /** Aggregated rows for this page. */
  data: TRow[];
  /** Page size echoed back. */
  limit: number;
  /** True when another page exists after this one. */
  hasMore: boolean;
  /**
   * Opaque cursor for the next page. `null` when `hasMore` is false.
   * Consumers pass this back as `req.after` verbatim.
   */
  next: string | null;
}

/**
 * Shape of each row returned by `aggregate` / `aggregatePaginate`.
 * Keys are the `groupBy` fields (when present) plus the measure
 * aliases. Values are SQL-native scalars — numbers for count / sum /
 * avg, the group-by column's native type for group keys.
 *
 * **Joined-alias paths in `groupBy` produce NESTED output rows.**
 * Same convention `lookupPopulate` uses, so cross-operation row
 * shapes stay consistent across all read primitives.
 *
 * ```ts
 * await orders.aggregate({
 *   lookups: [{ from: 'category', localField: 'categoryId',
 *               foreignField: '_id', as: 'category', single: true }],
 *   groupBy: ['status', 'category.code'],
 *   measures: { count: 'count', revenue: 'sum:totalPrice' },
 * });
 *
 * // → { rows: [
 * //     { status: 'pending', category: { code: 'BOOKS' }, count: 12, revenue: 800 },
 * //     ...
 * //   ]}
 * ```
 *
 * Both mongokit and sqlitekit normalize dotted-path groupBy keys to
 * nested objects on the returned row. Use repo-core's
 * `nestDottedKeys()` helper from `repository/agg-output.js` if you
 * receive flat-dotted rows from a future kit that hasn't normalized
 * yet, or build them yourself in tests.
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
   * Delete by primary key. Returns the {@link DeleteResult} on success or
   * `null` on miss (matches the `update()` null-on-miss convention).
   *
   * Pass `{ mode: 'hard' }` to bypass soft-delete interception (kits
   * without soft-delete accept and ignore the flag).
   */
  delete(id: string, options?: DeleteOptions): Promise<DeleteResult | null>;
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
   * Atomic compare-and-swap state transition. Standardized shape for
   * the canonical state-machine write that every domain package was
   * hand-rolling on top of `findOneAndUpdate`:
   *
   * ```ts
   * findOneAndUpdate(
   *   { _id: id, [field]: from },                 // CAS — match only when state matches
   *   { $set: { [field]: to, ...patch } },        // transition + patch
   * );
   * ```
   *
   * Returns the post-update doc on success; `null` when:
   *   - the row doesn't exist, OR
   *   - the row's `field` value isn't `from` (someone else transitioned
   *     first — the standard race-loss signal)
   *
   * **Cross-kit portable.** Mongokit compiles to the `findOneAndUpdate`
   * above. SQL kits compile to
   * `UPDATE x SET ... WHERE id = ? AND <field> = <from> RETURNING *`.
   * Prismakit compiles to `prisma.x.updateMany({ where: { id, [field]:
   * from }, data: ... })` then a `findUnique` when `count > 0`. Same
   * input, same null-on-race semantics across every backend.
   *
   * **Pairs with `@classytic/primitives/state-machine`.** Use
   * `defineStateMachine()` for the domain "is `from → to` a legal
   * transition?" gate (compile-time table + `assertTransition()` early
   * throw); use `claim()` for the concurrency "did we win the
   * transition vs concurrent writers?" gate (runtime null on race).
   * The two layers compose:
   *
   * ```ts
   * ORDER_MACHINE.assertTransition(id, current, 'shipped');
   * const claimed = await repo.claim(id, { from: current, to: 'shipped' });
   * if (!claimed) throw new ConcurrentTransitionError(id, current, 'shipped');
   * ```
   *
   * **Required.** Both mongokit and sqlitekit ship `claim` as a class
   * primitive. Downstream domain packages (~10 in classytic alone) all
   * carry FSM verbs depending on it — none gracefully degrade.
   * Required-on-the-contract removes the boilerplate `if (repo.claim)
   * { ... }` at every call site and surfaces missing implementations
   * at the conformance gate instead of at runtime.
   *
   * @param id - Document primary key value
   * @param transition - `{ from, to }` (defaults to the `status` field)
   *   or `{ field, from, to }` for state machines keyed off a non-`status`
   *   column (`phase`, `state`, etc.)
   * @param patch - Extra fields written alongside the transition (e.g.
   *   `{ lastHeartbeat: now, workerId: 'w-12' }`). Field-shape only —
   *   for raw operators use `findOneAndUpdate` directly.
   * @returns The updated document, or `null` when the CAS lost / no match
   */
  claim(
    id: string,
    transition: ClaimTransition,
    patch?: Partial<TDoc>,
    options?: WriteOptions,
  ): Promise<TDoc | null>;

  /**
   * Atomic optimistic-concurrency CAS via a version stamp. Sibling to
   * `claim` for the optimistic-locking pattern: "I read at version
   * N, write back only if no one's incremented since."
   *
   * Builds:
   *
   * ```ts
   * findOneAndUpdate(
   *   { _id, [versionField]: from, ...where },
   *   { ...update, $inc: { [versionField]: by ?? 1 } },
   * );
   * ```
   *
   * Returns the post-update doc on success, `null` when:
   *   - the row is missing,
   *   - the version doesn't match `from` (race-loss),
   *   - any `where` predicate fails.
   *
   * **Cross-kit portable.** Mongokit emits the operator update
   * directly. SQL kits compile to
   * `UPDATE x SET ... [versionField] = coalesce([versionField], 0) + by
   *  WHERE id = ? AND [versionField] = ? RETURNING *`.
   *
   * **Required.** Same rationale as `claim`. Mongokit and sqlitekit
   * both ship a class primitive; downstream domain packages that need
   * versioned writes (`@classytic/order`, `leave`, `payrun`) carry
   * verbs depending on it.
   *
   * @param update - Mongo-operator-shape (`{ $set, $inc, $unset }`)
   *   OR field-shape (auto-wrapped in `$set`). Mixed shapes throw —
   *   mongo would silently drop the flat keys. SQL kits accept the
   *   same shape and compile down to flat column writes.
   */
  claimVersion(
    id: string,
    transition: ClaimVersionTransition,
    update: Record<string, unknown>,
    options?: WriteOptions,
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
  /**
   * Atomic "look up by filter, insert `data` if missing, return the doc."
   *
   * Returns `{ doc, created }` so the caller can disambiguate the two
   * outcomes without a follow-up read. `created: true` means *this*
   * caller's `data` won the race and was just inserted; `created: false`
   * means a doc matching `filter` already existed and was returned
   * unchanged. This discriminator is load-bearing for race-detection in
   * idempotency stores, lock acquisition, and "ensure-exists" flows —
   * a bare `TDoc` return (without `created`) cannot answer the question
   * the method is named for.
   *
   * Implementations:
   *   - mongokit: `findOneAndUpdate({ filter }, { $setOnInsert: data },
   *     { upsert: true, returnDocument: 'after', includeResultMetadata: true })`
   *     and read `created = !!result.lastErrorObject?.upserted`.
   *   - sqlitekit: `INSERT … ON CONFLICT DO NOTHING RETURNING *` — when
   *     a row is returned, `created: true`; otherwise follow with
   *     `SELECT … WHERE filter` and return `created: false`.
   *   - Other kits: must preserve "single atomic round-trip" where
   *     possible; a non-atomic fallback is acceptable but should be
   *     documented.
   */
  getOrCreate?(
    filter: FilterInput,
    data: Partial<TDoc>,
    options?: WriteOptions,
  ): Promise<{ doc: TDoc; created: boolean }>;

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
   * Portable aggregation. Compiles to `SELECT ... [LEFT JOIN ...] GROUP
   * BY ...` on SQL kits and to a `[$match, $lookup*, $group, $sort,
   * $limit]` pipeline on mongokit. Output shape (`{ rows }`) is
   * identical across backends — dashboards and admin tooling read the
   * same result regardless of the driver.
   *
   * **Cross-table joins.** When `req.lookups` is set, the kit compiles
   * each `LookupSpec` as a join stage BEFORE the group/measure
   * pipeline. `groupBy`, `measure.field`, `having`, and `sort` may
   * then reference dotted paths into the joined aliases (e.g.
   * `'category.parent'`). Lookups in `aggregate` reuse the same
   * `LookupSpec` IR a kit's `lookupPopulate()` accepts — same
   * compile path, same semantics.
   *
   * **Kit support for `lookups` is incremental.** A kit that
   * implements `aggregate` but NOT yet `aggregate-with-lookups`
   * SHOULD throw `UnsupportedOperationError` at request time when
   * `req.lookups` is present, with a message telling the caller to
   * upgrade. Hosts pin via peer-deps; the API contract (this
   * interface) does NOT change as kits add support — additive only.
   *
   * **Boundary** — kit-native aggregation APIs (mongokit's
   * `aggregatePipeline(stages)`, sqlitekit's raw `repo.db`) remain
   * the escape hatch for window functions, CTEs, pipeline-form
   * `$lookup` with `let`, and lateral subqueries. The portable
   * `aggregate` covers the filter + lookups + group + measures +
   * having + sort + limit subset that every backend supports —
   * deliberately nothing else, so behavior stays identical across
   * drivers.
   */
  aggregate?<TRow extends AggRow = AggRow>(
    req: AggRequest,
    options?: QueryOptions,
  ): Promise<AggResult<TRow>>;

  /**
   * Paginated aggregation. Returns one of two envelope shapes,
   * discriminated by `method`:
   *
   * - **`offset`** (default) — standard offset envelope. Same shape
   *   `getAll({ page, limit })` produces for raw document lists.
   *   `countStrategy: 'none'` skips the distinct-group count for
   *   infinite-scroll use.
   * - **`keyset`** (when `req.pagination === 'keyset'` or `req.after`
   *   is set) — cursor-based envelope. Scales to arbitrary group
   *   counts because it never scans skipped rows.
   *
   * UI components branch on `result.method` once and render either
   * envelope identically.
   */
  aggregatePaginate?<TRow extends AggRow = AggRow>(
    req: AggPaginationRequest,
    options?: QueryOptions,
  ): Promise<OffsetPaginationResult<TRow> | KeysetAggPaginationResult<TRow>>;

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
