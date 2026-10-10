/**
 * `bulkUpsert` IR: many keyed upserts in ONE command, with a per-row outcome.
 *
 * Each row is matched by its `key` fields (plus the repository's own policy scope, a tenant
 * included); unmatched rows insert. Field routing: `inc` fields are `$inc`'d, `setOnInsert`
 * fields are written only on insert, every other non-key field is `$set` (or only the `set`
 * list when given). A field in two lists is refused. The kit REFUSES the call unless a unique
 * index covers the key (with the policy scope), so a key can never match two rows.
 * Outcomes are exact, never inferred: a row the backend did not report on is never `updated`.
 */

import type { WriteOptions } from './types.js';

export type BulkUpsertOutcome = 'inserted' | 'updated' | 'unchanged' | 'failed';

export const BULK_UPSERT_FAILURE_CODES = {
  /** A unique index other than (or racing on) the key refused the row. */
  DUPLICATE: 'duplicate',
  /** Schema / document validation refused the row. */
  VALIDATION: 'validation',
  /** The row lacks a key field (or carries a non-numeric `inc` field); it was not sent. */
  INVALID_ROW: 'invalid_row',
  /** `ordered: true` stopped at an earlier failure; this row was not attempted. */
  NOT_ATTEMPTED: 'not_attempted',
  /** Any other per-row write error. */
  WRITE_ERROR: 'write_error',
} as const;

export type BulkUpsertFailureCode =
  (typeof BULK_UPSERT_FAILURE_CODES)[keyof typeof BULK_UPSERT_FAILURE_CODES];

export const BULK_UPSERT_ERROR_CODES = {
  /** No unique index covers the key (with the policy scope): refused before any write. */
  KEY_NOT_UNIQUE: 'repo.bulk_upsert.key_not_unique',
  /** A field is routed to two of `set` / `inc` / `setOnInsert`, or a key field is routed at all. */
  INVALID_OPTIONS: 'repo.bulk_upsert.invalid_options',
  /** The backend cannot report a per-row outcome (Mongo: server < 8.0). */
  UNSUPPORTED: 'repo.bulk_upsert.unsupported',
} as const;

export interface BulkUpsertOptions extends WriteOptions {
  /** Fields that identify a row. Required; a unique index must cover them. */
  key: readonly string[];
  /** When given, only these fields are `$set`; otherwise every non-key, non-routed field. */
  set?: readonly string[];
  /** Fields added with `$inc` (numeric). */
  inc?: readonly string[];
  /** Fields written only when the row is inserted. */
  setOnInsert?: readonly string[];
  /** Stop at the first failure (later rows `not_attempted`). Default `false`. */
  ordered?: boolean;
}

export interface BulkUpsertRowResult {
  /** Position in the input array. */
  index: number;
  /** The row's key values, as given. */
  key: Record<string, unknown>;
  outcome: BulkUpsertOutcome;
  /** Present iff `outcome === 'failed'`. */
  code?: BulkUpsertFailureCode;
}

export interface BulkUpsertResult {
  /** One entry per input row, in input order. */
  results: readonly BulkUpsertRowResult[];
  inserted: number;
  updated: number;
  unchanged: number;
  failed: number;
}

/** Validate field routing; returns the error message, or undefined when the options are valid. */
export function bulkUpsertOptionsError(options: BulkUpsertOptions): string | undefined {
  if (!Array.isArray(options.key) || options.key.length === 0)
    return '`key` must name at least one field';
  const seen = new Map<string, string>();
  for (const [list, fields] of [
    ['key', options.key],
    ['set', options.set ?? []],
    ['inc', options.inc ?? []],
    ['setOnInsert', options.setOnInsert ?? []],
  ] as const) {
    for (const field of fields) {
      const prior = seen.get(field);
      if (prior) return `field '${field}' is in both \`${prior}\` and \`${list}\``;
      seen.set(field, list);
    }
  }
  return undefined;
}

/** Tally a positional result list into the summary counts. */
export function summarizeBulkUpsert(results: readonly BulkUpsertRowResult[]): BulkUpsertResult {
  const out = { results, inserted: 0, updated: 0, unchanged: 0, failed: 0 };
  for (const r of results) out[r.outcome] += 1;
  return out;
}
