/**
 * Cross-kit conformance harness types.
 *
 * A conformance suite proves that two repository implementations
 * (mongokit, sqlitekit, future pgkit / prismakit) behave identically
 * for the same `StandardRepo<TDoc>` contract — so application code can
 * swap one for the other without regressions.
 *
 * Each kit provides a `ConformanceHarness`. `runStandardRepoConformance`
 * consumes the harness and emits a vitest suite that exercises the
 * full cross-backend surface.
 */

import type { MinimalRepo, StandardRepo } from '../repository/types.js';

// ──────────────────────────────────────────────────────────────────────
// Shared conformance document shape
// ──────────────────────────────────────────────────────────────────────

/**
 * The conformance scenarios operate on a minimal doc shape common to
 * every backend:
 *
 *   - `name`, `email`, `category`, `active`, `count`, `notes` — plain
 *     scalar fields every driver supports.
 *   - `createdAt` — ISO string. Avoids Date/epoch coercion divergence.
 *   - `_id` / `id` — the harness decides which one its backend uses;
 *     scenarios read it via `harness.idField`.
 *
 * The intent is to keep the schema lowest-common-denominator, not to
 * exercise backend-specific features (JSON mode, BSON subdocs, vector
 * fields). Those stay per-kit.
 */
export interface ConformanceDoc {
  id?: string;
  _id?: string;
  name: string;
  email: string;
  category: string | null;
  count: number;
  active: boolean;
  notes: string | null;
  createdAt: string;
}

// ──────────────────────────────────────────────────────────────────────
// Feature flags
// ──────────────────────────────────────────────────────────────────────

/**
 * Per-aggregate-op support matrix. Some aggregate ops aren't
 * portable across every backend — `percentile` requires Mongo 7+'s
 * `$percentile` accumulator or SQL's `PERCENTILE_CONT`, neither of
 * which sqlitekit ships. Scenarios that exercise a non-universal
 * op gate on the matching flag and `it.skip` on the off branch so
 * the suite runs cleanly across every environment.
 *
 * **Stability contract.** Adding a flag here is additive — kits
 * that don't declare the new key default to `false`, which is the
 * conservative choice. Renaming or removing a flag is a breaking
 * change.
 *
 * **Naming convention.** Flag names match the IR field they gate
 * (`percentile` → `AggMeasure.op === 'percentile'`). When in doubt,
 * grep the IR types and use the same identifier.
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
 * Per-backend feature flags. Scenarios that exercise a non-universal
 * capability (transactions in D1, upsert in narrow stores) check the
 * flag and `it.skip` on the off branch — so the suite runs on every
 * environment without "optional test failed" noise.
 */
export interface ConformanceFeatures {
  /** `withTransaction(fn)` — D1 throws, standalone Mongo throws 263. */
  transactions: boolean;
  /**
   * True if calling `withTransaction` inside another `withTransaction`
   * callback is expected to work. Mongo's driver supports it via the
   * same session; SQL drivers typically reject it. Either behavior is
   * valid — the scenario asserts whichever the harness declares.
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
   * top-level flag — gates the entire `describe('aggregate')` block.
   * Per-op flags live on `aggregateOps` for asymmetric capabilities
   * (percentile, custom date bins, etc.) that some kits skip while
   * still supporting the core aggregate surface.
   */
  aggregate: boolean;
  /**
   * Per-op feature matrix for the aggregate surface. Optional —
   * absent matrix or absent key both mean "not supported", so kits
   * opt INTO scenarios for ops they implement. This avoids the
   * trap where a future kit silently fails percentile tests because
   * it forgot to set the flag.
   */
  aggregateOps?: AggregateOpsSupport;
  /** `getOrCreate(filter, data)`. */
  getOrCreate: boolean;
  /** `count(filter)` and `exists(filter)`. */
  countAndExists: boolean;
  /**
   * `purgeByField(field, value, strategy, options)` — compliance-grade
   * tenant cleanup primitive. Both mongokit and sqlitekit ship this as
   * of repo-core 0.x. Future kits without it leave the flag absent
   * (defaults to false) and skip the cleanup scenarios.
   */
  purgeByField?: boolean;
}

// ──────────────────────────────────────────────────────────────────────
// Harness contract
// ──────────────────────────────────────────────────────────────────────

/**
 * One-shot context produced by `harness.setup()`. Scenarios receive a
 * fresh context per test — the harness is responsible for isolation
 * (new collection name on mongo, fresh `:memory:` db on sqlite).
 */
export interface ConformanceContext<TDoc extends ConformanceDoc = ConformanceDoc> {
  /** Repository under test. */
  repo: StandardRepo<TDoc> & MinimalRepo<TDoc>;
  /**
   * Optional secondary repository pointing at a DIFFERENT collection /
   * table — scenarios that exercise cross-repo atomicity use it. May
   * be omitted; scenarios that need it will skip if missing.
   */
  secondaryRepo?: StandardRepo<TDoc> & MinimalRepo<TDoc>;
  /**
   * Optional repo-with-cache for cache-suite scenarios. Required iff
   * the harness declares `features.aggregateOps.cache === true`.
   *
   * **Why a separate repo** rather than reconfiguring the primary
   * one: cache state survives across calls within a test, and the
   * primary repo is shared by every other suite. A dedicated cached
   * repo keeps the cache scenarios hermetic.
   *
   * The bound type widens to include `invalidateAggregateCache` —
   * cast at the use site since the contract type
   * (`StandardRepo<TDoc>`) doesn't currently surface it. This
   * intentionally leaves the contract narrower than the
   * implementation; consumers pin to a specific kit when they need
   * the invalidate method on their `RepositoryLike` slot.
   */
  cachedRepo?: StandardRepo<TDoc> &
    MinimalRepo<TDoc> & {
      invalidateAggregateCache(tags?: readonly string[]): Promise<number>;
    };
  /** Release resources (close db, drop collection). Must be idempotent. */
  cleanup(): Promise<void>;
}

/**
 * Harness plugged into `runStandardRepoConformance`.
 *
 * The harness owns:
 *   - Backend bootstrap (mongo connection, sqlite db + migrations).
 *   - Doc factory — returns a partial doc with default values filled in.
 *     Scenarios call `makeDoc({ name: 'override' })` to produce inserts.
 *   - Feature flags — declares what the backend supports.
 *   - idField — `'id'` for sqlitekit, `'_id'` for mongokit. Scenarios
 *     read this to project the primary key off returned docs.
 */
export interface ConformanceHarness<TDoc extends ConformanceDoc = ConformanceDoc> {
  /** Human-readable kit name, used as the top-level describe() label. */
  name: string;
  /**
   * Name of the primary-key field on docs the repo returns. `'id'` for
   * sqlitekit, `'_id'` for mongokit, could be `'uuid'` or anything else
   * for future kits. Scenarios read ids via `doc[idField]`.
   */
  idField: string;
  /** Feature support flags — skipped scenarios show as `skipped` in vitest output. */
  features: ConformanceFeatures;
  /** Create a fresh, isolated repo + cleanup closure. Called per test. */
  setup(): Promise<ConformanceContext<TDoc>>;
  /**
   * Build a partial doc with fixture-safe defaults. Passed-in overrides
   * merge on top. Do NOT include `id`/`_id` unless the caller overrides
   * (scenarios usually let the backend assign or set one explicitly).
   *
   * Overrides are typed against `ConformanceDoc` (not `TDoc`) because
   * the shared scenarios only know the common doc shape. Kits that use
   * a wider `TDoc` with extra required fields fill those in inside
   * their harness's `makeDoc` implementation — the scenarios never
   * reference them.
   */
  makeDoc(overrides?: Partial<ConformanceDoc>): Partial<TDoc>;
}
