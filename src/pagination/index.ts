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
  calculateSkip,
  calculateTotalPages,
  shouldWarnDeepPagination,
  validateLimit,
  validatePage,
} from './offset.js';
export type {
  CursorPayload,
  DecodedCursor,
  KeysetPaginationResult,
  KeysetPaginationResultCore,
  OffsetPaginationResult,
  OffsetPaginationResultCore,
  PaginationConfig,
  SortDirection,
  SortSpec,
  ValueType,
} from './types.js';
