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

export { RepositoryBase, type RepositoryBaseOptions } from './base.js';
export {
  PLUGIN_ORDER_CONSTRAINTS,
  type Plugin,
  type PluginFunction,
  type PluginType,
  validatePluginOrder,
} from './plugin-types.js';
export type {
  DeleteManyResult,
  DeleteOptions,
  DeleteResult,
  FindOneAndUpdateOptions,
  InferDoc,
  MinimalRepo,
  PaginationParams,
  QueryOptions,
  RepositorySession,
  StandardRepo,
  UpdateManyResult,
  WriteOptions,
} from './types.js';
