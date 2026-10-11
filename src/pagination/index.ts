/**
 * Public entry for the `pagination` subpath.
 *
 * Consumers import from `@classytic/repo-core/pagination`. Internal files
 * (`cursor.ts`, `keyset.ts`, `offset.ts`, `types.ts`) are implementation
 * details and may be restructured between minor versions.
 *
 * Intentional scope: this module is the *model* (types + algorithms). It
 * does not emit any driver-native keyset predicate — translation from a
 * decoded cursor to a SQL/Mongo/Prisma WHERE clause lives in each kit.
 */

/** Re-exported for convenience; browser bundles import it from `@classytic/repo-core/errors`. */
export { CURSOR_ERROR_CODES } from '../errors/codes.js';
export { isPaginatedResult, toCanonicalList } from './canonical.js';
export {
  decodeCursor,
  encodeCursor,
  validateCursorSort,
  validateCursorVersion,
} from './cursor.js';
export {
  getPrimaryField,
  invertSort,
  normalizeSort,
  validateKeysetSort,
} from './keyset.js';
export {
  type KeysetSource,
  type MergedKeysetPage,
  type MergeKeysetOptions,
  mergeKeysetPages,
} from './merge-keyset.js';
export {
  calculateSkip,
  calculateTotalPages,
  shouldWarnDeepPagination,
  validateLimit,
  validatePage,
} from './offset.js';
export type {
  AggregatePaginationResult,
  AggregatePaginationResultCore,
  AnyPaginationResult,
  BareListResult,
  CursorPayload,
  DecodedCursor,
  KeysetPaginationResult,
  KeysetPaginationResultCore,
  OffsetPaginationResult,
  OffsetPaginationResultCore,
  PaginatedResult,
  PaginationConfig,
  SortDirection,
  SortSpec,
  ValueType,
} from './types.js';
