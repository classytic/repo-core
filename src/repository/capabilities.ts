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
   * True if calling `withTransaction` inside another `withTransaction`
   * callback is expected to work. Mongo's driver supports it via the
   * same session; SQL drivers typically reject it.
   */
  nestedTransactions: boolean;
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
