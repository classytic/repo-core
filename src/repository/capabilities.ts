/**
 * Runtime capability descriptor — the feature-detection contract every
 * kit declares so hosts (and arc) can branch on backend support at boot
 * instead of discovering an `UnsupportedOperationError` at runtime.
 *
 * One shape, two consumers:
 *
 *   - **Runtime**: `repo.capabilities.arrayOperators` tells a kit-portable
 *     host whether `$push` / `$pull` updates will work before it ships a
 *     write that throws on SQLite.
 *   - **Conformance**: the cross-kit test harness declares the same shape
 *     (`ConformanceFeatures` in `@classytic/repo-core/testing` is an alias
 *     of this type) — the flags a kit declares at runtime are exactly the
 *     scenarios the conformance suite exercises. One source of truth; the
 *     two can't drift.
 *
 * **Stability contract.** Adding a flag is additive — kits that don't
 * declare a new optional key default to "not supported", the conservative
 * read. Renaming or removing a flag is a breaking change.
 *
 * **Naming convention.** Flag names match the surface they gate
 * (`percentile` → `AggMeasure.op === 'percentile'`, `changeStreams` →
 * `StandardRepo.watch`). When in doubt, grep the contract types and use
 * the same identifier.
 */

/**
 * Per-aggregate-op support matrix. Some aggregate ops aren't portable
 * across every backend — `percentile` requires Mongo 7+'s `$percentile`
 * accumulator or SQL's `PERCENTILE_CONT`, neither of which sqlitekit
 * ships. Kits opt INTO support; absent keys mean "not supported".
 */
export interface AggregateOpsSupport {
  /**
   * `{ op: 'percentile', field, p }` measure. Mongokit (Mongo 7+)
   * supports it; sqlitekit throws by design (no native function).
   * Hosts targeting percentile dashboards pin to a kit that supports it.
   */
  percentile?: boolean;
  /**
   * `{ op: 'stddev', field }` / `{ op: 'stddevPop', field }` measures.
   * Mongokit supports both via native `$stdDevSamp` / `$stdDevPop`
   * (Welford). Sqlitekit throws — SQLite has no native STDDEV and
   * the computational formula is numerically unstable. Hosts pin
   * to mongokit / future pgkit when stddev is load-bearing.
   */
  stddev?: boolean;
  /**
   * `topN: { partitionBy, sortBy, limit, ties }` filter. Both
   * mongokit and sqlitekit support it as of repo-core 0.4.x; the
   * flag exists for future kits that may not ship window-function
   * equivalents.
   */
  topN?: boolean;
  /**
   * `AggDateBucket.timezone` — bucket boundaries drawn in an IANA zone
   * rather than UTC. Mongokit supports it natively (`$dateTrunc` /
   * `$dateToString` both take `timezone`). SQLite has no tz database, so
   * sqlitekit cannot draw DST-correct boundaries and MUST THROW rather
   * than silently bucketing in UTC — a wrong-period number that looks
   * right is worse than a refusal.
   */
  dateBucketTimezone?: boolean;
  /**
   * `dateBuckets: { ..., interval: { every, unit } }` custom-bin
   * form. Kits that only support named-bucket form can leave this
   * `false`; tests for `'minute'` / `'hour'` named intervals are
   * gated separately via `dateBucketSubMinute`.
   */
  customDateBuckets?: boolean;
  /**
   * Sub-day-granularity named buckets (`'minute'` / `'hour'`).
   * Older kits may only support day+ named intervals; flag exists
   * to gate those scenarios cleanly.
   */
  dateBucketSubMinute?: boolean;
  /**
   * Per-request `cache?: AggCacheOptions` slot — TTL / tags / SWR /
   * bypass / `repo.invalidateAggregateCache(tags)`. Both mongokit
   * and sqlitekit support it as of repo-core 0.4.x. Future kits
   * without the wiring can leave this false to skip cache scenarios.
   *
   * Independent of which CACHE BACKEND the harness wires — test
   * scenarios construct their own `createMemoryCacheAdapter()` so
   * this flag is purely "does the kit honour the request slot".
   */
  cache?: boolean;
}

/**
 * Per-kit capability flags. Every `StandardRepo` implementation declares
 * one of these as `readonly capabilities` — the runtime twin of the
 * conformance harness's feature declaration.
 *
 * Hosts that target multiple kits feature-detect once at boot:
 *
 * ```ts
 * if (!repo.capabilities.arrayOperators) {
 *   // SQL kit — model tags as a join table instead of $push on a JSON column
 * }
 * ```
 */
export interface RepoCapabilities {
  /** `withTransaction(fn)` — D1 throws, standalone Mongo throws 263. */
  transactions: boolean;
  /**
   * `WriteOptions.ifVersion` CAS honored (stale version → thrown
   * `VersionConflictError`, success increments the version). Kits without
   * it throw on the option — see the `ifVersion` contract.
   */
  optimisticConcurrency?: boolean;
  /**
   * True if calling `withTransaction` inside another `withTransaction`
   * callback is expected to work — as observed on THIS repository, not on
   * the underlying driver. A kit whose tx-bound repo throws on nested
   * `withTransaction` declares `false` even when its driver would allow
   * nesting on the raw session: the capability describes what a caller
   * holding this object may do. Conformance asserts the two agree.
   */
  nestedTransactions: boolean;
  /**
   * WHO owns retry of a transaction aborted by a transient conflict.
   *
   * - `'managed'` — `withTransaction` retries internally (MongoDB's
   *   convenient transaction API re-runs the callback on
   *   `TransientTransactionError` / `UnknownTransactionCommitResult` for up
   *   to 120s). The caller MUST invoke it exactly once.
   * - `'caller'` — one attempt per call; an outer envelope
   *   (`retryingTransaction`) owns the loop. Manual BEGIN/COMMIT kits.
   *
   * **Absent means `'managed'`** — i.e. `retryingTransaction` does not add a
   * retry layer. Wrapping a self-retrying transaction multiplies the retry
   * budget (5 outer attempts × a 120s inner window) and makes the callback's
   * execution count unpredictable, which is the strictly worse failure: a
   * missing retry surfaces a conflict as a 409, a nested one re-runs side
   * effects an unbounded number of times. Same posture as
   * {@link neverTransient} — silence means "don't".
   *
   * A kit exposing `withTransaction` MUST declare this (conformance checks).
   */
  transactionRetry?: 'managed' | 'caller';
  /**
   * This repository refuses writes — another component owns them and
   * enforces invariants the table cannot express (Better Auth's identity
   * collections, a SQL view, a read replica). Write methods throw
   * `ReadOnlyRepositoryError`; hosts should refuse write ROUTES at boot
   * rather than surfacing the wall on the first request.
   *
   * Absent means writable, so nothing changes for ordinary repositories.
   * Set it via {@link asReadOnlyRepo} rather than by hand — the flag alone
   * is a label, and a label is not a control.
   */
  readOnly?: boolean;
  /** `findOneAndUpdate` with upsert: true. */
  upsert: boolean;
  /** `isDuplicateKeyError(err)` classifier. */
  duplicateKeyError: boolean;
  /** `distinct(field)`. */
  distinct: boolean;
  /**
   * Portable `aggregate({ measures, groupBy, having })`. Coarse
   * top-level flag. Per-op flags live on `aggregateOps` for asymmetric
   * capabilities (percentile, custom date bins, etc.).
   */
  aggregate: boolean;
  /**
   * Per-op feature matrix for the aggregate surface. Optional —
   * absent matrix or absent key both mean "not supported", so kits
   * opt INTO ops they implement.
   */
  aggregateOps?: AggregateOpsSupport;
  /** `getOrCreate(filter, data)`. */
  getOrCreate: boolean;
  /** `count(filter)` and `exists(filter)`. */
  countAndExists: boolean;
  /**
   * `purgeByField(field, value, strategy, options)` — compliance-grade
   * tenant cleanup primitive.
   */
  purgeByField?: boolean;
  /**
   * `purgeByFilter(filter, strategy, options)` — range/filter-scoped
   * variant of `purgeByField`. Processes rows matching an arbitrary
   * compiled filter (a `civilDate` window, a retention cutoff, a compound
   * cohort) rather than a single `field = value` equality — the GDPR /
   * retention "anonymize a slice across a RANGE while retaining measures"
   * primitive.
   */
  purgeByFilter?: boolean;
  /**
   * `archiveByFilter(filter, sink, options)` — chunked cold-storage
   * extraction (write-before-delete, at-least-once). The data-lifecycle
   * twin of `purgeByField`.
   */
  archiveByFilter?: boolean;
  /**
   * Mongo-style array update operators (`$push`, `$pull`, `$addToSet`,
   * `$pop`, `$pullAll`). Mongokit: native. Sqlitekit: implemented over
   * JSON TEXT columns via `json_insert` / `json_each` rewrites — see
   * the sqlitekit docs for the supported subset.
   */
  arrayOperators?: boolean;
  /**
   * Filter IR `regex` op. Mongokit: native `$regex`. Sqlitekit throws
   * unless the host registers a `REGEXP` SQL function on the connection.
   */
  regexFilter?: boolean;
  /**
   * `watch(filter?)` change feed — `AsyncIterable<ChangeEvent<TDoc>>`.
   * Mongokit: Mongo change streams (replica set required). Kits without
   * a native feed leave this false and omit the method.
   */
  changeStreams?: boolean;
  /**
   * `lean: true` read option — return plain objects instead of driver
   * documents. SQL kits return plain rows always (trivially true);
   * mongokit opts in once reads honor the flag.
   */
  lean?: boolean;
  /** Portable `lookupPopulate(options)` join IR. */
  lookupPopulate?: boolean;
  /** `cursor(filter, options)` streaming reads (AsyncIterable batches). */
  streaming?: boolean;
}
