/**
 * Public entry for the `errors` subpath.
 *
 * Consumers import from `@classytic/repo-core/errors`. Driver kits
 * compose their own error boundary on top — repo-core provides the
 * canonical shapes and a conservative Mongo-compat fallback predicate;
 * kits ship their own driver-specific classifiers.
 */

export { createError, isHttpError } from './create-error.js';
export {
  conservativeMongoIsDuplicateKey,
  type IsDuplicateKeyErrorFn,
  type ToDuplicateKeyHttpErrorOptions,
  toDuplicateKeyHttpError,
} from './duplicate-key.js';
export type { DuplicateKeyMeta, HttpError, ValidationErrorMeta } from './types.js';
