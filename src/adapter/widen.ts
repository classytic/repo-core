/**
 * Widening helper for adapter inputs.
 *
 * Documented escape hatch for the filter-IR variance documented on
 * `AdapterRepositoryInput`. Lives in repo-core (not at every host call
 * site) so the cast is single-source.
 */

import type { AdapterRepositoryInput, RepositoryLike } from './types.js';

/**
 * Widen a permissive `AdapterRepositoryInput<TDoc>` to the strict
 * `RepositoryLike<TDoc>` view used by host internals.
 *
 * Single-source cast — kit adapters call this once at their factory
 * boundary; host code (arc, future arc-next) consumes the strict view
 * everywhere else.
 */
export function asRepositoryLike<TDoc = unknown>(
  input: AdapterRepositoryInput<TDoc>,
): RepositoryLike<TDoc> {
  return input as unknown as RepositoryLike<TDoc>;
}

/**
 * Runtime guard: does `value` look like a `RepositoryLike<TDoc>`?
 *
 * Checks for the five required methods (`getAll`, `getById`, `create`,
 * `update`, `delete`) plus the optional `idField`. Used by adapter
 * factories to validate input before wrapping.
 */
export function isRepository<TDoc = unknown>(value: unknown): value is RepositoryLike<TDoc> {
  if (!value || typeof value !== 'object') return false;
  const v = value as Record<string, unknown>;
  return (
    typeof v['getAll'] === 'function' &&
    typeof v['getById'] === 'function' &&
    typeof v['create'] === 'function' &&
    typeof v['update'] === 'function' &&
    typeof v['delete'] === 'function'
  );
}
