/**
 * ISO-date coercion for record-shape filters — the canonical helper every
 * kit shares.
 *
 * WHY THIS EXISTS. A URL carries strings (`?createdAt[gte]=2026-04-01`), but
 * the stored column is a real date. On a `find`-family call Mongoose casts
 * the query against the schema, so a string silently becomes a `Date` and
 * everything works. **An aggregation `$match` stage gets no such casting** —
 * and BSON type ordering makes `Date` (type 9) and `String` (type 2)
 * non-comparable, so `{ createdAt: { $gte: '2026-04-01' } }` matches
 * NOTHING against a Date field. Silent empty result, no error. The same
 * hazard exists for any kit comparing a typed column to a string literal.
 *
 * Coercion therefore has to happen in the shared layer, before a kit emits
 * its native predicate — which is what this module is for. It is
 * DIALECT-PRESERVING (record in, record out): it never converts to the
 * Filter IR, so a caller that hands over Mongo-dialect syntax gets
 * Mongo-dialect syntax back, just with dates typed correctly. That keeps it
 * usable from `compileFilterToMongo`'s already-built-query passthrough
 * branch, where converting to IR would lose operators the IR doesn't model.
 *
 * Two shapes are handled, because both reach the compile boundary:
 *   - **bare shorthand** — `{ gte: '…' }`, what Fastify parses out of arc's
 *     bracket-syntax URL params, and
 *   - **`$`-prefixed** — `{ $gte: '…' }`, already-built Mongo/policy syntax.
 *
 * Logical wrappers (`$and` / `$or` / `$nor` / `$not`) are recursed — the
 * same operator set {@link policyRecordToFilter} walks, kept deliberately in
 * sync. Without recursion a date range nested under `$and` (exactly what a
 * tenant/policy-scope merge produces when it conjoins a policy filter with a
 * caller filter) is never coerced.
 */

/**
 * Tight ISO-8601 pattern — date-only through millisecond precision with an
 * optional timezone. Anchored at BOTH ends on purpose: a loose prefix-only
 * match (`/^\d{4}-\d{2}-\d{2}/`) also swallows strings that merely START
 * with something date-shaped (order numbers, slugs, serials), silently
 * rewriting a legitimate string predicate into a Date one.
 *
 * THE single source of truth — `query-parser/coerce.ts` imports it rather
 * than keeping a second copy.
 */
export const ISO_DATE_PATTERN =
  /^\d{4}-\d{2}-\d{2}(?:T\d{2}:\d{2}(?::\d{2}(?:\.\d{1,3})?)?(?:Z|[+-]\d{2}:?\d{2})?)?$/;

/**
 * Coerce one value to a `Date` when it is an unambiguous ISO-8601 string.
 * Anything else — including an unparseable date-shaped string — is returned
 * untouched, so this is always safe to apply.
 */
export function tryCoerceIsoDate(value: unknown): unknown {
  if (typeof value !== 'string' || !ISO_DATE_PATTERN.test(value)) return value;
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? value : parsed;
}

/**
 * Range operators whose operand is compared by BSON/SQL type and therefore
 * must be a real date, not a string. Equality is deliberately EXCLUDED:
 * `{ status: '2026-01-01' }` is far more likely a string id than a date, and
 * an `eq` against a Date column is the one case a caller can express exactly
 * by passing a `Date`. Both bare and `$`-prefixed spellings are listed.
 */
const RANGE_OPS = new Set(['gt', 'gte', 'lt', 'lte', '$gt', '$gte', '$lt', '$lte']);

/** Logical operators whose operand is an ARRAY of sub-filters. */
const LOGICAL_ARRAY_OPS = new Set(['$and', '$or', '$nor', 'and', 'or', 'nor']);

/** Logical operators whose operand is a SINGLE nested sub-filter. */
const LOGICAL_OBJECT_OPS = new Set(['$not', 'not']);

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return (
    value !== null && typeof value === 'object' && !Array.isArray(value) && !(value instanceof Date)
  );
}

/**
 * Walk a record-shape filter and coerce ISO-date strings on range operators
 * to `Date`, recursing through logical wrappers. Returns a new object;
 * the input is never mutated. Non-range operators, real nested documents,
 * and already-typed values pass through unchanged.
 *
 * @example
 * ```ts
 * coerceFilterDates({ $and: [{ createdAt: { $gte: '2026-04-01' } }] })
 * // → { $and: [{ createdAt: { $gte: Date(2026-04-01) } }] }
 * ```
 */
export interface CoerceFilterDatesOptions {
  /**
   * Schema oracle: given a field path, is it actually date-typed?
   *
   * WITHOUT this the coercion is a guess based only on how the VALUE looks, and the guess
   * is wrong for any string column whose contents happen to be ISO-shaped — a civil date
   * (`'2026-08-02'`), a version, a period key. Coercing there produces the exact failure
   * this function exists to prevent, in reverse: the bound becomes a Date, BSON will not
   * compare Date to String, and the range silently matches NOTHING.
   *
   * That cost real time. A sales-fact reconciler filtered `civilDate` — a `String` field
   * holding `'YYYY-MM-DD'` — with `$gte`/`$lte`. The bounds were coerced to Dates, the
   * aggregate returned zero rows for every window, and the report therefore accused the
   * PROJECTOR of having written nothing, for every cell, forever. The projection was
   * correct the whole time; the reconciler was comparing a Date to a String.
   *
   * Return `false` to leave the operand exactly as given. Omit the option entirely to keep
   * the old value-shape-only behaviour (correct for callers with no schema to consult,
   * such as a URL query parser).
   */
  isDateField?: (field: string) => boolean;
}

export function coerceFilterDates(
  filter: Record<string, unknown>,
  options?: CoerceFilterDatesOptions,
): Record<string, unknown> {
  const out: Record<string, unknown> = {};

  for (const [key, value] of Object.entries(filter)) {
    if (LOGICAL_ARRAY_OPS.has(key) && Array.isArray(value)) {
      out[key] = value.map((entry) => (isPlainObject(entry) ? coerceFilterDates(entry, options) : entry));
      continue;
    }

    if (LOGICAL_OBJECT_OPS.has(key) && isPlainObject(value)) {
      out[key] = coerceFilterDates(value, options);
      continue;
    }

    // Field-level operator object — coerce range operands in place. Keys
    // that aren't range operators (and their values) are preserved exactly,
    // so `{ address: { city: 'Dhaka' } }` and `{ tags: { $in: [...] } }`
    // are untouched.
    if (isPlainObject(value)) {
      let changed = false;
      const coerced: Record<string, unknown> = {};
      // The oracle is consulted ONCE per field, not per operator — a field is date-typed
      // or it is not, and asking per operand would let `$gte` and `$lte` disagree.
      const coercible = options?.isDateField === undefined || options.isDateField(key);
      for (const [op, operand] of Object.entries(value)) {
        if (coercible && RANGE_OPS.has(op)) {
          const next = tryCoerceIsoDate(operand);
          coerced[op] = next;
          if (next !== operand) changed = true;
        } else {
          coerced[op] = operand;
        }
      }
      out[key] = changed ? coerced : value;
      continue;
    }

    out[key] = value;
  }

  return out;
}
