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
 *
 * `vitest` is deliberately NOT declared as a dependency or a peer: whoever
 * imports this subpath is already inside a vitest suite that provides it, and
 * the import resolves from the consumer's own install. Declaring it as an
 * optional peer was strictly worse — `peerDependenciesMeta.optional` only
 * silences the "missing" case, while npm still hard-fails ERESOLVE on a version
 * MISMATCH, so consumers on a newer vitest could not install repo-core at all
 * despite never importing `./testing`. Any vitest version exposing the standard
 * `describe` / `it` / `expect` / `beforeEach` / `afterEach` globals works.
 */

export { runStandardRepoConformance } from './conformance.js';
export type { IdempotencyConformanceHarness } from './idempotency-conformance.js';
export {
  idempotencyStoreCases,
  runIdempotencyStoreConformance,
} from './idempotency-conformance.js';
export type { LockConformanceHarness } from './lock-conformance.js';

export { runLockAdapterConformance } from './lock-conformance.js';
export type {
  PurgeConformanceContext,
  PurgeConformanceHarness,
} from './purge-conformance.js';
export { runPurgeConformance } from './purge-conformance.js';
export {
  QUERY_GRAMMAR_DOCS,
  QUERY_GRAMMAR_FILTER_CASES,
  QUERY_GRAMMAR_PAGING_CASES,
  QUERY_GRAMMAR_REFUSED,
  type QueryGrammarCaseOptions,
  type QueryGrammarConformanceOptions,
  type QueryGrammarHarness,
  type QueryGrammarParsed,
  runQueryGrammarConformance,
} from './query-grammar-conformance.js';
export type {
  AggregateOpsSupport,
  ConformanceContext,
  ConformanceDoc,
  ConformanceFeatures,
  ConformanceHarness,
} from './types.js';
export type { UsageConformanceHarness } from './usage-conformance.js';
export { runUsageStoreContract } from './usage-conformance.js';
