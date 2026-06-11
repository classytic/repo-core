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

import type { AggregateOpsSupport, RepoCapabilities } from '../repository/capabilities.js';
import type { MinimalRepo, StandardRepo } from '../repository/types.js';

export type { AggregateOpsSupport };

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
 * Per-backend feature flags — an alias of the runtime
 * {@link RepoCapabilities} descriptor (one shape, no drift). Scenarios
 * that exercise a non-universal capability (transactions in D1, upsert
 * in narrow stores) check the flag and `it.skip` on the off branch — so
 * the suite runs on every environment without "optional test failed"
 * noise.
 *
 * **Single source of truth.** Kits declare `repo.capabilities` at
 * runtime and pass the SAME object as the harness's `features` — what a
 * kit claims to support is exactly what the conformance suite verifies.
 */
export type ConformanceFeatures = RepoCapabilities;

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
