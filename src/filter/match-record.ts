/**
 * Mongo-record `_policyFilters` → Filter IR conversion + in-memory match.
 *
 * The CANONICAL, single home for evaluating arc's row-level policy filters
 * against an already-fetched document IN PROCESS (no DB round-trip). Every
 * kit's `DataAdapter.matchesFilter` delegates here — one contract, one IR,
 * no per-kit matcher.
 *
 * Arc's permission helpers emit policy filters in Mongo record syntax,
 * kit-agnostic (`requireOwnership` → `{ ownerId }`, multiTenant →
 * `{ organizationId }`, `requireGrant` list resolutions →
 * `{ $or: [{ ownerId }, { _id: { $in } }] }`). This module converts that
 * record into the portable {@link Filter} IR and evaluates it with the
 * shared {@link matchFilter} engine — the SAME IR kits compile to SQL /
 * Mongo, so in-memory and DB-level enforcement agree by construction.
 *
 * `matchFilter` is id-coercion aware (Mongo `ObjectId` `_id` matches its
 * string form — no kit-specific coercion) and array-aware (dot-paths fan
 * out over subdocument arrays; scalar conditions on array fields match any
 * element). See `match.ts`.
 *
 * SCOPE — the operators arc's policy filters emit. Fails LOUD on anything
 * else so a silent mismatch never masquerades as a denial:
 *
 *   logical:    $or, $and, $nor, $not
 *   comparison: implicit-eq, $eq, $ne, $gt, $gte, $lt, $lte
 *   membership: $in, $nin
 *   existence:  $exists (see divergence note below)
 *   pattern:    $regex (+ $options; RegExp literal accepted)
 *
 * MongoDB parity (validated against the MongoDB manual + sift/mingo):
 *   - Missing field ≡ null for `{field: null}`, `$ne`/`$nin`, and a `null`
 *     member of `$in`/`$nin` — the authorization-critical rule (a policy
 *     filter `{ status: { $ne: 'archived' } }` MUST return docs lacking the
 *     field, exactly as MongoDB does).
 *   - `$in` accepts RegExp-literal members (Mongo allows `/re/` in `$in`).
 *   - Comparison ops are TYPE-BRACKETED: no cross-type ordering
 *     (`{ n: { $gt: 5 } }` never matches a string `n`); `$gt: null` matches
 *     nothing. NaN equals NaN for `$eq`.
 *   - Dot-paths fan out over arrays AND resolve numeric segments as
 *     positional indices (`items.0.sku`).
 *
 * DELIBERATE divergences (documented, not bugs):
 *   - `$exists` = present-AND-non-null (a null value reads as absent),
 *     matching the shared IR `exists` op + SQL `IS NOT NULL` + sift.js.
 *     MongoDB/mingo treat present-null as existing; that would require a
 *     separate key-presence IR op threaded through every kit's SQL/Mongo
 *     compiler. Arc's built-in policy helpers never emit `$exists`; a
 *     custom filter that needs Mongo key-presence should use
 *     `{ field: { $ne: null } }` (present + non-null) or `{ field: null }`
 *     (null OR missing) instead.
 *   - `$gt`/`$lt` allow ONE cross-type leniency: a `Date` field compares
 *     against an ISO-string operand (JSON policy filters carry dates as
 *     strings). Consistent with `$eq`'s Date⇄string coercion.
 *   - An array-literal operand (`{ tags: ['a','b'] }`) is element-matched,
 *     not exact-array-matched — policy filters never assert whole-array
 *     equality.
 *
 * Distinct from {@link recordToFilter}, which is the ergonomic
 * record→IR normalizer for BARE-operator query shorthand (`{ price:
 * { gte } }`) and deliberately does NOT accept `$`-prefixed operators or
 * logical `$or`/`$and`. This function is the arc-policy-filter dialect
 * (`$`-prefixed, with logical operators).
 */

import {
  and,
  eq,
  FALSE,
  gt,
  gte,
  in_,
  isNotNull,
  isNull,
  lt,
  lte,
  ne,
  not,
  or,
  regex,
  TRUE,
} from './builders.js';
import { matchFilter } from './match.js';
import type { Filter } from './types.js';

/** Field operators understood inside a `{ field: { ... } }` condition. */
const FIELD_OPS = [
  '$eq',
  '$ne',
  '$gt',
  '$gte',
  '$lt',
  '$lte',
  '$in',
  '$nin',
  '$exists',
  '$regex',
] as const;

function isOperatorObject(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== 'object') return false;
  if (Array.isArray(value) || value instanceof Date) return false;
  const keys = Object.keys(value as object);
  return keys.length > 0 && keys.every((k) => k.startsWith('$'));
}

/**
 * `$in` with MongoDB parity: a `null` member also matches a MISSING field
 * (inherits `{field: null}` semantics), and RegExp-literal members match by
 * pattern (Mongo allows `/re/` inside `$in`). Split members into
 * null / regex / scalar and OR the branches.
 */
function buildIn(field: string, members: readonly unknown[]): Filter {
  const branches: Filter[] = [];
  const scalars: unknown[] = [];
  let hasNull = false;
  for (const m of members) {
    if (m === null || m === undefined) hasNull = true;
    else if (m instanceof RegExp) branches.push(regex(field, m.source, m.flags));
    else scalars.push(m);
  }
  if (hasNull) branches.push(isNull(field)); // null member ⇒ null-value OR missing
  if (scalars.length > 0) branches.push(in_(field, scalars));
  if (branches.length === 0) return FALSE; // `$in: []` matches nothing
  return branches.length === 1 ? (branches[0] as Filter) : or(...branches);
}

/** `$nin` is the negation of `$in` — none of the members may match. */
function buildNin(field: string, members: readonly unknown[]): Filter {
  const inFilter = buildIn(field, members);
  // `$nin: []` matches everything (negation of "matches nothing").
  return inFilter.op === 'false' ? TRUE : not(inFilter);
}

/** Convert a single `{ field: condition }` entry into a Filter IR node. */
function fieldFilter(field: string, condition: unknown): Filter {
  if (!isOperatorObject(condition)) {
    // Implicit equality (incl. `{ field: null }` → isNull).
    return condition === null ? isNull(field) : eq(field, condition);
  }
  const parts: Filter[] = [];
  const options = typeof condition['$options'] === 'string' ? condition['$options'] : undefined;
  for (const [op, operand] of Object.entries(condition)) {
    switch (op) {
      case '$options':
        break; // consumed alongside $regex
      case '$eq':
        parts.push(operand === null ? isNull(field) : eq(field, operand));
        break;
      case '$ne':
        parts.push(operand === null ? isNotNull(field) : ne(field, operand));
        break;
      case '$gt':
        parts.push(gt(field, operand as never));
        break;
      case '$gte':
        parts.push(gte(field, operand as never));
        break;
      case '$lt':
        parts.push(lt(field, operand as never));
        break;
      case '$lte':
        parts.push(lte(field, operand as never));
        break;
      case '$in':
        parts.push(buildIn(field, (operand as unknown[]) ?? []));
        break;
      case '$nin':
        parts.push(buildNin(field, (operand as unknown[]) ?? []));
        break;
      case '$exists':
        parts.push(operand ? isNotNull(field) : isNull(field));
        break;
      case '$regex': {
        const pattern = operand instanceof RegExp ? operand.source : String(operand);
        const flags = operand instanceof RegExp ? operand.flags : options;
        parts.push(flags ? regex(field, pattern, flags) : regex(field, pattern));
        break;
      }
      default:
        throw new Error(
          `[repo-core] matchesRecordFilter: unsupported field operator '${op}'. ` +
            `Supported: ${FIELD_OPS.join(', ')}.`,
        );
    }
  }
  return parts.length === 1 ? (parts[0] as Filter) : and(...parts);
}

/**
 * Convert an arc Mongo-record `_policyFilters` object into Filter IR.
 * `{}` → `TRUE`. Throws on unsupported top-level operators.
 */
export function policyRecordToFilter(record: Record<string, unknown>): Filter {
  const parts: Filter[] = [];
  for (const [key, value] of Object.entries(record)) {
    if (key === '$or') {
      parts.push(or(...asFilterArray(value)));
    } else if (key === '$and') {
      parts.push(and(...asFilterArray(value)));
    } else if (key === '$nor') {
      // NOR = NOT(OR(...)) — none of the branches may match.
      parts.push(not(or(...asFilterArray(value))));
    } else if (key === '$not') {
      parts.push(not(policyRecordToFilter(value as Record<string, unknown>)));
    } else if (key.startsWith('$')) {
      throw new Error(
        `[repo-core] matchesRecordFilter: unsupported top-level operator '${key}'. ` +
          `Supported: $and, $or, $nor, $not.`,
      );
    } else {
      parts.push(fieldFilter(key, value));
    }
  }
  if (parts.length === 0) return TRUE;
  return parts.length === 1 ? (parts[0] as Filter) : and(...parts);
}

function asFilterArray(value: unknown): Filter[] {
  if (!Array.isArray(value)) {
    throw new Error('[repo-core] matchesRecordFilter: $or/$and/$nor operand must be an array');
  }
  return value.map((entry) => policyRecordToFilter(entry as Record<string, unknown>));
}

/**
 * Evaluate an arc Mongo-record `_policyFilters` object against a document —
 * converts to Filter IR, then delegates to the shared {@link matchFilter}
 * engine. THE canonical `DataAdapter.matchesFilter` implementation; every
 * kit's adapter delegates here.
 *
 * @param item    The already-fetched document / row.
 * @param filters Arc's `_policyFilters` in Mongo record syntax.
 */
export function matchesRecordFilter(item: unknown, filters: Record<string, unknown>): boolean {
  if (item === null || typeof item !== 'object') return false;
  return matchFilter(item, policyRecordToFilter(filters));
}
