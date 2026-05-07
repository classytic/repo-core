/**
 * Public entry for the `testing` subpath.
 *
 * Exposes the cross-kit conformance suite so every kit (mongokit,
 * sqlitekit, pgkit, prismakit) can prove it satisfies the
 * `StandardRepo<TDoc>` contract by running identical scenarios.
 *
 * Depends on `vitest` at import time. That's intentional — this
 * subpath is consumed from test files only. It should never be
 * imported from runtime / production code.
 */

export { runStandardRepoConformance } from './conformance.js';
export type { LockConformanceHarness } from './lock-conformance.js';

export { runLockAdapterConformance } from './lock-conformance.js';
export type {
  AggregateOpsSupport,
  ConformanceContext,
  ConformanceDoc,
  ConformanceFeatures,
  ConformanceHarness,
} from './types.js';
