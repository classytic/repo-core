/**
 * Filter combinators — the typed builder API plugins and kits use instead
 * of constructing AST nodes by hand. Every builder returns a frozen node so
 * Filter trees stay immutable in transit through the hook pipeline.
 *
 * Naming: `in_` / `not_` are suffixed to avoid collision with JS reserved
 * words. Prefer the readable aliases `anyOf` / `noneOf` / `invert` where
 * the plugin code reads better with those names.
 */

import type {
  Filter,
  FilterAnd,
  FilterEq,
  FilterExists,
  FilterFalse,
  FilterGt,
  FilterGte,
  FilterIn,
  FilterLike,
  FilterLt,
  FilterLte,
  FilterNe,
  FilterNin,
  FilterNot,
  FilterOr,
  FilterRaw,
  FilterRegex,
  FilterTrue,
} from './types.js';

// ──────────────────────────────────────────────────────────────────────
// Leaf comparators
// ──────────────────────────────────────────────────────────────────────

export const eq = (field: string, value: unknown): FilterEq =>
  Object.freeze({ op: 'eq', field, value });

export const ne = (field: string, value: unknown): FilterNe =>
  Object.freeze({ op: 'ne', field, value });

export const gt = (field: string, value: unknown): FilterGt =>
  Object.freeze({ op: 'gt', field, value });

export const gte = (field: string, value: unknown): FilterGte =>
  Object.freeze({ op: 'gte', field, value });

export const lt = (field: string, value: unknown): FilterLt =>
  Object.freeze({ op: 'lt', field, value });

export const lte = (field: string, value: unknown): FilterLte =>
  Object.freeze({ op: 'lte', field, value });

/** Membership (`$in` / `IN (...)`). Aliased as `anyOf` for readability. */
export const in_ = (field: string, values: readonly unknown[]): FilterIn =>
  Object.freeze({ op: 'in', field, values: Object.freeze([...values]) });
export { in_ as anyOf };

/** Non-membership (`$nin` / `NOT IN (...)`). Aliased as `noneOf`. */
export const nin = (field: string, values: readonly unknown[]): FilterNin =>
  Object.freeze({ op: 'nin', field, values: Object.freeze([...values]) });
export { nin as noneOf };

export const like = (
  field: string,
  pattern: string,
  caseSensitivity: 'sensitive' | 'insensitive' = 'insensitive',
): FilterLike => Object.freeze({ op: 'like', field, pattern, caseSensitivity });

export const regex = (field: string, pattern: string, flags?: string): FilterRegex => {
  const node = { op: 'regex' as const, field, pattern, ...(flags !== undefined && { flags }) };
  return Object.freeze(node);
};

export const exists = (field: string, present = true): FilterExists =>
  Object.freeze({ op: 'exists', field, exists: present });

// ──────────────────────────────────────────────────────────────────────
// Boolean composition
// ──────────────────────────────────────────────────────────────────────

/**
 * Conjunction. Normalizes trivially: an empty `and` returns `TRUE`, a
 * single-child `and` is flattened to the child. Plugins that progressively
 * build a filter (`let f = TRUE; if (...) f = and(f, eq(...))`) land in
 * the expected shape without manual tree surgery.
 */
export function and(...children: Filter[]): Filter {
  // Flatten nested and, then apply boolean algebra:
  //   and(...x, FALSE, ...y) = FALSE        (absorbing)
  //   and(..., TRUE, ...)     = and(..., ...) (drop identity)
  const flat: Filter[] = [];
  for (const c of children) {
    if (c.op === 'and') flat.push(...c.children);
    else flat.push(c);
  }
  const filtered: Filter[] = [];
  for (const c of flat) {
    if (c.op === 'false') return FALSE;
    if (c.op === 'true') continue;
    filtered.push(c);
  }
  if (filtered.length === 0) return TRUE;
  if (filtered.length === 1) return filtered[0] as Filter;
  const node: FilterAnd = { op: 'and', children: Object.freeze(filtered) };
  return Object.freeze(node);
}

/** Disjunction. Boolean algebra duals of `and`: TRUE absorbs, FALSE is identity. */
export function or(...children: Filter[]): Filter {
  const flat: Filter[] = [];
  for (const c of children) {
    if (c.op === 'or') flat.push(...c.children);
    else flat.push(c);
  }
  const filtered: Filter[] = [];
  for (const c of flat) {
    if (c.op === 'true') return TRUE;
    if (c.op === 'false') continue;
    filtered.push(c);
  }
  if (filtered.length === 0) return FALSE;
  if (filtered.length === 1) return filtered[0] as Filter;
  const node: FilterOr = { op: 'or', children: Object.freeze(filtered) };
  return Object.freeze(node);
}

/** Negation. Double-negation is eliminated (`not(not(x)) === x`). */
export function not(child: Filter): Filter {
  if (child.op === 'not') return child.child;
  if (child.op === 'true') return FALSE;
  if (child.op === 'false') return TRUE;
  const node: FilterNot = { op: 'not', child };
  return Object.freeze(node);
}

// Aliases for code that reads better with verbal names.
export { not as invert };

// ──────────────────────────────────────────────────────────────────────
// Identities
// ──────────────────────────────────────────────────────────────────────

/** Matches every document. Identity element for `and`. */
export const TRUE: FilterTrue = Object.freeze({ op: 'true' });

/** Matches no document. Identity element for `or`. */
export const FALSE: FilterFalse = Object.freeze({ op: 'false' });

// ──────────────────────────────────────────────────────────────────────
// Sugar builders — desugar to existing ops, no new IR nodes
// ──────────────────────────────────────────────────────────────────────

/** Inclusive range: `lo <= field <= hi`. Desugars to `and(gte, lte)`. */
export function between(field: string, lo: unknown, hi: unknown): Filter {
  return and(gte(field, lo), lte(field, hi));
}

/** Case-insensitive by default. Escapes `%` and `_` in `prefix` so they match literally. */
export function startsWith(
  field: string,
  prefix: string,
  caseSensitivity: 'sensitive' | 'insensitive' = 'insensitive',
): FilterLike {
  return like(field, `${escapeLikePattern(prefix)}%`, caseSensitivity);
}

export function endsWith(
  field: string,
  suffix: string,
  caseSensitivity: 'sensitive' | 'insensitive' = 'insensitive',
): FilterLike {
  return like(field, `%${escapeLikePattern(suffix)}`, caseSensitivity);
}

/** Substring match. Case-insensitive by default. */
export function contains(
  field: string,
  substring: string,
  caseSensitivity: 'sensitive' | 'insensitive' = 'insensitive',
): FilterLike {
  return like(field, `%${escapeLikePattern(substring)}%`, caseSensitivity);
}

/**
 * Case-insensitive equality. Desugars to a case-insensitive `like` with
 * the value's SQL wildcards escaped — kits compile it the same as an
 * equality check against `lower(field) = lower(?)`.
 */
export function iEq(field: string, value: string): FilterLike {
  return like(field, escapeLikePattern(value), 'insensitive');
}

/** Shorthand for `exists(field, false)`. Reads better in plugin code. */
export function isNull(field: string): FilterExists {
  return exists(field, false);
}

/** Shorthand for `exists(field, true)`. */
export function isNotNull(field: string): FilterExists {
  return exists(field, true);
}

// ──────────────────────────────────────────────────────────────────────
// Raw escape hatch — opaque driver-native fragment
// ──────────────────────────────────────────────────────────────────────

/**
 * Embed a driver-native fragment verbatim. Use for features the IR
 * doesn't express: pgvector similarity, SQLite JSON1 path access,
 * Mongo `$geoWithin`, etc.
 *
 * `matchFilter` (the in-memory evaluator) returns `false` for raw nodes
 * because evaluating arbitrary SQL in JS isn't possible — make sure
 * predicates used in client-side filtering don't rely on `raw`.
 */
export function raw(sql: string, params: readonly unknown[] = []): FilterRaw {
  return Object.freeze({ op: 'raw', sql, params: Object.freeze([...params]) });
}

// Export the FilterRaw type alongside the builder so kit compilers can
// narrow on it.
export type { FilterRaw };

// Internal — escape SQL LIKE wildcards in a literal substring so
// startsWith/endsWith/contains behave intuitively.
function escapeLikePattern(value: string): string {
  return value.replace(/[%_]/g, (c) => `\\${c}`);
}
