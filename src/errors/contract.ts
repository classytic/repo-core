/**
 * Wire-contract helpers — convert throwable {@link HttpError} into the
 * serializable {@link ErrorContract} shape, with a `code` cascade so any
 * thrown error produces a sensible wire envelope even when it's a plain
 * `Error` from third-party code.
 */

import type { ErrorCode, ErrorContract, HttpError } from './types.js';
import { ERROR_CODES } from './types.js';

/**
 * Map an HTTP status code to the canonical {@link ErrorCode}. Used as a
 * fallback when a thrown `HttpError` lacks an explicit `code` field.
 *
 * The mapping is conservative: only well-known status codes get a
 * canonical code; unmapped statuses (406, 422, 410, ...) flow through as
 * `'internal_error'` because there's no portable HTTP-Spec mapping
 * everyone agrees on. Domain handlers should set `code` explicitly for
 * any non-default status.
 */
export function statusToErrorCode(status: number): ErrorCode {
  switch (status) {
    case 400:
      return ERROR_CODES.VALIDATION;
    case 401:
      return ERROR_CODES.UNAUTHORIZED;
    case 403:
      return ERROR_CODES.FORBIDDEN;
    case 404:
      return ERROR_CODES.NOT_FOUND;
    case 409:
      return ERROR_CODES.CONFLICT;
    case 412:
      return ERROR_CODES.PRECONDITION_FAILED;
    case 429:
      return ERROR_CODES.RATE_LIMITED;
    case 503:
      return ERROR_CODES.UNAVAILABLE;
    case 504:
      return ERROR_CODES.TIMEOUT;
    default:
      return ERROR_CODES.INTERNAL;
  }
}

/**
 * Convert a throwable {@link HttpError} (or any `Error` with a `status`
 * field) into the canonical {@link ErrorContract} wire shape.
 *
 * `code` cascade:
 *   1. `error.code` (explicit machine code on the throwable) — preferred.
 *   2. {@link statusToErrorCode}(`error.status`) — derived from status.
 *   3. `'internal_error'` — fallback for plain `Error` without status.
 *
 * `validationErrors` (mongokit-shaped throwable field) is mapped into the
 * canonical `details` array so wire consumers see one shape regardless
 * of which kit threw the error. Each `validationErrors[i]` becomes an
 * `ErrorDetail` with `code: validator`, `message: error`, `path` left
 * unset (kits that have field paths set them in their own ErrorDetail
 * mapping).
 *
 * `duplicate.fields` is similarly flattened into `details` with the
 * duplicate-key code so unique-constraint failures look uniform on the
 * wire.
 */
export function toErrorContract(error: unknown): ErrorContract {
  if (!(error instanceof Error)) {
    return {
      code: 'internal_error',
      message: typeof error === 'string' ? error : 'Internal error',
      status: 500,
    };
  }

  const e = error as HttpError;
  const status = typeof e.status === 'number' ? e.status : 500;
  const code = e.code ?? statusToErrorCode(status);

  const contract: ErrorContract = {
    code,
    message: e.message || 'Internal error',
    status,
  };

  // Map throwable structured fields into the canonical `details` array.
  const details: Array<{ path?: string; code: string; message: string }> = [];
  if (Array.isArray(e.validationErrors)) {
    for (const v of e.validationErrors) {
      details.push({ code: v.validator, message: v.error });
    }
  }
  if (e.duplicate?.fields?.length) {
    for (const field of e.duplicate.fields) {
      details.push({
        path: field,
        code: 'duplicate_key',
        message: `Duplicate value for "${field}"`,
      });
    }
  }
  if (details.length > 0) contract.details = details;

  if (e.meta) contract.meta = e.meta;

  return contract;
}
