/**
 * Public entry for the `errors` subpath.
 *
 * Consumers import from `@classytic/repo-core/errors`. Driver kits
 * compose their own error boundary on top — repo-core provides the
 * canonical shapes and a conservative Mongo-compat fallback predicate;
 * kits ship their own driver-specific classifiers.
 */

export {
  ARC_ERROR_CODES,
  ARC_REASON_CODES,
  type ArcErrorCode,
  type ArcReasonCode,
  DUPLICATE_KEY_DETAIL_CODE,
  ERROR_CODES,
  type ErrorCode,
} from './codes.js';
export {
  conservativeMongoIsTransientConflict,
  type IsTransientConflictFn,
  isVersionConflictError,
  neverTransient,
  VersionConflictError,
} from './conflict.js';
export { statusToErrorCode, toErrorContract } from './contract.js';
export { createError, isHttpError } from './create-error.js';
export {
  conservativeMongoIsDuplicateKey,
  type IsDuplicateKeyErrorFn,
  type ToDuplicateKeyHttpErrorOptions,
  toDuplicateKeyHttpError,
} from './duplicate-key.js';
export { errorContractSchema, errorDetailSchema } from './schema.js';
export type {
  DuplicateKeyMeta,
  ErrorContract,
  ErrorDetail,
  HttpError,
  ValidationErrorMeta,
} from './types.js';
