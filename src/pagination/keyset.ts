/**
 * Keyset (cursor-based) pagination helpers.
 *
 * These helpers shape the sort specification used by cursor pagination.
 * They don't emit any driver syntax — translating a decoded cursor into
 * a native keyset predicate (Mongo `$gt`/`$lt`, SQL tuple comparison,
 * Prisma `cursor`) lives in each kit's compiler.
 *
 * Known limitation (carries over from mongokit): keyset pagination across
 * a nullable field is lossy in every backend that doesn't define a total
 * order between typed values and null. Use `allowedPrimaryFields` to lock
 * keyset sorts to fields your schema guarantees non-null.
 */

import type { SortDirection, SortSpec } from './types.js';

/**
 * Normalize a sort object so non-`_id` fields come first, `_id` last.
 * Stable ordering is required for cursor comparability across requests.
 */
export function normalizeSort(sort: SortSpec): SortSpec {
  const normalized: SortSpec = {};
  for (const key of Object.keys(sort)) {
    if (key !== '_id') {
      const direction = sort[key];
      if (direction !== undefined) normalized[key] = direction;
    }
  }
  const idDirection = sort['_id'];
  if (idDirection !== undefined) normalized['_id'] = idDirection;
  return normalized;
}

/**
 * Validate a sort spec for keyset pagination and return the normalized form.
 *
 * - Rejects empty sorts (keyset needs at least one field).
 * - Rejects non-`±1` directions.
 * - Rejects mixed directions across fields (keyset can't straddle directions).
 * - Auto-adds `_id` as tie-breaker (matching the primary direction) when absent.
 * - When `allowedPrimaryFields` is non-empty, rejects primary fields outside
 *   the allowlist (protects against lossy null-boundary keyset).
 */
export function validateKeysetSort(
  sort: SortSpec,
  allowedPrimaryFields?: readonly string[],
): SortSpec {
  const keys = Object.keys(sort);
  if (keys.length === 0) {
    throw new Error('Keyset pagination requires at least one sort field');
  }

  if (keys.length === 1 && keys[0] === '_id') {
    return normalizeSort(sort);
  }

  for (const key of keys) {
    const direction = sort[key];
    if (direction !== 1 && direction !== -1) {
      throw new Error(
        `Invalid sort direction for "${key}": must be 1 or -1, got ${String(direction)}`,
      );
    }
  }

  const nonIdKeys = keys.filter((k) => k !== '_id');
  const firstNonId = nonIdKeys[0];
  if (firstNonId === undefined) {
    // All keys were `_id` after filtering (only possible with duplicate _id),
    // handled by the single-field branch above. Guarded for the type-narrower.
    return normalizeSort(sort);
  }
  const primaryDirection = sort[firstNonId] as SortDirection;

  if (allowedPrimaryFields && allowedPrimaryFields.length > 0) {
    for (const key of nonIdKeys) {
      if (!allowedPrimaryFields.includes(key)) {
        throw new Error(
          `Keyset sort field "${key}" is not in the strictKeysetSortFields allowlist. ` +
            `Allowed: ${allowedPrimaryFields.join(', ')}. ` +
            `(Protects against lossy null/non-null keyset boundaries.)`,
        );
      }
    }
  }

  for (const key of nonIdKeys) {
    if (sort[key] !== primaryDirection) {
      throw new Error('All sort fields must share the same direction for keyset pagination');
    }
  }

  if (keys.includes('_id') && sort['_id'] !== primaryDirection) {
    throw new Error('_id direction must match primary field direction');
  }

  if (!keys.includes('_id')) {
    return normalizeSort({ ...sort, _id: primaryDirection });
  }

  return normalizeSort(sort);
}

/** Invert every direction in a sort (ascending ↔ descending). */
export function invertSort(sort: SortSpec): SortSpec {
  const inverted: SortSpec = {};
  for (const key of Object.keys(sort)) {
    inverted[key] = sort[key] === 1 ? -1 : 1;
  }
  return inverted;
}

/** Primary (first non-`_id`) sort field; falls back to `_id`. */
export function getPrimaryField(sort: SortSpec): string {
  for (const key of Object.keys(sort)) {
    if (key !== '_id') return key;
  }
  return '_id';
}
