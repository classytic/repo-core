import type { HttpError } from './types.js';

/**
 * Create an error with an HTTP status code attached.
 *
 * Pure helper. No driver knowledge. Used by every kit at its error boundary:
 *
 * ```ts
 * throw createError(404, 'Document not found');
 * throw createError(400, 'Invalid input');
 * throw createError(409, 'Conflict');
 * ```
 */
export function createError(status: number, message: string): HttpError {
  const error: HttpError = Object.assign(new Error(message), { status });
  return error;
}

/** Runtime predicate — true when `value` already carries an `HttpError` shape. */
export function isHttpError(value: unknown): value is HttpError {
  if (!(value instanceof Error)) return false;
  const status = (value as unknown as { status?: unknown }).status;
  return typeof status === 'number' && Number.isFinite(status);
}
