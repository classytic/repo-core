/**
 * Duplicate-key detection — driver-agnostic contract.
 *
 * Every backend signals unique-constraint violations differently:
 *
 * | Backend    | Signal                                                |
 * |------------|-------------------------------------------------------|
 * | MongoDB    | `err.code === 11000` / `codeName === 'DuplicateKey'`  |
 * | Prisma     | `err.code === 'P2002'`                                |
 * | Postgres   | `err.code === '23505'`                                |
 * | SQLite     | message contains `'UNIQUE constraint failed'`         |
 *
 * Classification belongs in the kit that knows its driver. Arc's
 * idempotency / outbox adapters depend only on the boolean outcome of
 * `repository.isDuplicateKeyError(err)`, so this module defines the
 * shared contract — the `IsDuplicateKeyErrorFn` type and a safe default
 * fallback — and leaves the concrete predicate to each kit.
 */

import { createError } from './create-error.js';
import type { DuplicateKeyMeta, HttpError } from './types.js';

/** Predicate shape kits implement and repositories expose as `isDuplicateKeyError`. */
export type IsDuplicateKeyErrorFn = (err: unknown) => boolean;

/**
 * Conservative fallback predicate. Used by arc ONLY when the repository
 * doesn't expose `isDuplicateKeyError` — preserves back-compat with
 * mongokit ≤3.8 which didn't export the predicate. Matches ONLY MongoDB's
 * narrow signals so it never swallows a transactional retry error.
 *
 * Non-Mongo kits MUST implement their own `isDuplicateKeyError` — the
 * fallback returns `false` for their native signals (P2002, 23505, etc.).
 */
export const conservativeMongoIsDuplicateKey: IsDuplicateKeyErrorFn = (err) => {
  if (!err || typeof err !== 'object') return false;
  const e = err as { code?: unknown; codeName?: unknown };
  return e.code === 11000 || e.codeName === 'DuplicateKey';
};

/** Options for `toDuplicateKeyHttpError`. */
export interface ToDuplicateKeyHttpErrorOptions {
  /**
   * Include offending values inline in the error message and under
   * `error.duplicate.values`. Default `false` — values can be PII and
   * end up in logs/crash reports. Enable in dev or trusted internal tools.
   */
  exposeValues?: boolean;
}

/**
 * Build a 409 `HttpError` from already-extracted duplicate-key metadata.
 *
 * Kits call their driver-specific extractor (`extractMongoE11000`,
 * `extractPrismaP2002`, ...) and pass the resulting `{ fields, values }`
 * bundle here. Repo-core stays driver-free — it only knows the shape of
 * the canonical 409 error.
 *
 * PII-safe by default: the message names fields only. Values are attached
 * only when `exposeValues: true`.
 */
export function toDuplicateKeyHttpError(
  meta: DuplicateKeyMeta,
  options: ToDuplicateKeyHttpErrorOptions = {},
): HttpError {
  const exposed = options.exposeValues === true;
  const valuesString =
    exposed && meta.values
      ? Object.entries(meta.values)
          .map(([k, v]) => `${k}: ${JSON.stringify(v)}`)
          .join(', ')
      : '';

  const detail = meta.fields.length
    ? `Duplicate value for ${meta.fields.join(', ')}${valuesString ? ` (${valuesString})` : ''}`
    : 'Duplicate key error';

  const httpError = createError(409, detail);
  httpError.duplicate = {
    fields: meta.fields,
    ...(exposed && meta.values ? { values: { ...meta.values } } : {}),
  };
  return httpError;
}
