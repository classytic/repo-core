/**
 * Public entry for the `repository` subpath.
 *
 * This is the contract surface — types only, no runtime. Kits import these
 * types to declare conformance; arc imports `MinimalRepo` so its
 * `RepositoryLike` becomes "anything matching this shape."
 *
 * The abstract `RepositoryBase` class lands in a separate subpath later
 * (`@classytic/repo-core/repository/base`) — consumers who want the hook
 * machinery opt in explicitly rather than dragging it through
 * `RepositoryLike`.
 */

/**
 * Re-export the lookup IR from `repository/` too — consumers of
 * `@classytic/repo-core/repository` expect the full contract surface
 * there, and a separate `/lookup` subpath exists for kits that only
 * want the types without the broader contract.
 */
export type {
  LookupPopulateOptions,
  LookupPopulateResult,
  LookupRow,
  LookupSpec,
} from '../lookup/types.js';
/**
 * Re-export of `UpdateInput` for contract-surface convenience. The canonical
 * home is `@classytic/repo-core/update` (which also exports the builders and
 * compilers). Kits may import from either path — they name the same type.
 */
export type { UpdateInput } from '../update/types.js';
export { nestDottedKeys, nestDottedKeysAll } from './agg-output.js';
export { RepositoryBase, type RepositoryBaseOptions } from './base.js';
export {
  STANDARD_REPO_OPTION_KEYS,
  type StandardRepoOptionKey,
} from './options.js';
export {
  PLUGIN_ORDER_CONSTRAINTS,
  type Plugin,
  type PluginFunction,
  type PluginType,
  validatePluginOrder,
} from './plugin-types.js';
export type {
  AggCacheOptions,
  AggDateBucket,
  AggDateBucketInterval,
  AggDateBucketUnit,
  AggExecutionHints,
  AggMeasure,
  AggPaginationRequest,
  AggRequest,
  AggResult,
  AggRow,
  AggTopN,
  AggTopNTies,
  BulkCreateResult,
  BulkWriteOperation,
  BulkWriteResult,
  ClaimTransition,
  ClaimVersionTransition,
  DeleteManyResult,
  DeleteOptions,
  DeleteResult,
  FilterInput,
  FindOneAndUpdateOptions,
  InferDoc,
  KeysetAggPaginationResult,
  MinimalRepo,
  PaginationParams,
  QueryOptions,
  RepositorySession,
  StandardRepo,
  UpdateManyResult,
  WriteOptions,
} from './types.js';
