/**
 * Compilers — translate `UpdateSpec` into backend-native shapes.
 *
 * Kits import the compiler they need instead of re-implementing the fan-out.
 * Keeping compilers here means the IR → native mapping has exactly one
 * definition per backend — arc's stores and host app code share the same
 * semantics regardless of which kit ends up under them.
 *
 * Compilers are pure functions; no side effects, no validation errors beyond
 * what the shape guarantees. Kit-specific constraints (e.g. SQLite forbids
 * incrementing a JSON column without `json_set`) stay in the kit.
 */

import type { UpdateSpec } from './types.js';

// ──────────────────────────────────────────────────────────────────────
// Mongo / mongokit
// ──────────────────────────────────────────────────────────────────────

/**
 * Compile an `UpdateSpec` to a Mongo operator record.
 *
 * Empty buckets are omitted — passing `{ $set: {} }` to Mongo is a no-op
 * per-op but still round-trips through the driver as a valid update, so
 * leaving them out keeps the wire format tidy.
 *
 * `$unset` values follow the Mongo convention (empty string) — the value
 * is ignored by the server, only the key matters.
 */
export function compileUpdateSpecToMongo(spec: UpdateSpec): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  if (spec.set && Object.keys(spec.set).length > 0) {
    out['$set'] = { ...spec.set };
  }
  if (spec.unset && spec.unset.length > 0) {
    const unsetRecord: Record<string, ''> = {};
    for (const field of spec.unset) unsetRecord[field] = '';
    out['$unset'] = unsetRecord;
  }
  if (spec.setOnInsert && Object.keys(spec.setOnInsert).length > 0) {
    out['$setOnInsert'] = { ...spec.setOnInsert };
  }
  if (spec.inc && Object.keys(spec.inc).length > 0) {
    out['$inc'] = { ...spec.inc };
  }
  return out;
}

// ──────────────────────────────────────────────────────────────────────
// SQL-flat (sqlitekit, pgkit, Prisma scalar updates)
// ──────────────────────────────────────────────────────────────────────

/**
 * Compile an `UpdateSpec` to a SQL-friendly breakdown.
 *
 * SQL kits can't express a single "update record" the way Mongo can — they
 * need:
 *
 *   - `data` for plain `SET col = ?` assignments (both `set` and
 *     `setOnInsert` feed here; the kit decides how to route `setOnInsert`
 *     when the UPDATE path hits a matched row vs inserted row).
 *   - `unset` for `SET col = NULL` clauses.
 *   - `inc` for `SET col = coalesce(col, 0) + ?` clauses.
 *   - `insertDefaults` for the INSERT branch of an upsert — fields that
 *     should ONLY apply when no row matched.
 *
 * Callers build the final SQL from these pieces. This helper intentionally
 * doesn't emit SQL strings — driver quoting, parameter binding, and
 * `ON CONFLICT` grammar differ too much between SQLite, Postgres, and
 * Prisma for a shared compiler to own it.
 */
export interface SqlUpdatePlan {
  /** Plain column assignments. Merge of `set` — applied on UPDATE and INSERT. */
  readonly data: Readonly<Record<string, unknown>>;
  /** Columns to set NULL. */
  readonly unset: readonly string[];
  /** Atomic numeric deltas — kit emits `col = coalesce(col, 0) + ?`. */
  readonly inc: Readonly<Record<string, number>>;
  /** Fields to set only when the upsert takes the INSERT branch. */
  readonly insertDefaults: Readonly<Record<string, unknown>>;
}

export function compileUpdateSpecToSql(spec: UpdateSpec): SqlUpdatePlan {
  return Object.freeze({
    data: Object.freeze({ ...(spec.set ?? {}) }),
    unset: Object.freeze([...(spec.unset ?? [])]),
    inc: Object.freeze({ ...(spec.inc ?? {}) }),
    insertDefaults: Object.freeze({ ...(spec.setOnInsert ?? {}) }),
  });
}
