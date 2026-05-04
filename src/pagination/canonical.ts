/**
 * Canonical list-envelope normalizer.
 *
 * `toCanonicalList(input)` accepts any of:
 *   - `T[]` / `readonly T[]` — bare array (an endpoint that doesn't paginate)
 *   - {@link OffsetPaginationResult} / {@link KeysetPaginationResult} /
 *     {@link AggregatePaginationResult} — anything a `RepositoryLike` returns
 *
 * and emits the matching {@link PaginatedResult} wire shape. The `method`
 * discriminant on paginated results carries straight through; bare arrays
 * produce a {@link BareListResult} (`{data: T[]}`).
 *
 * This is the single point where the *internal* repo result becomes the
 * *external* HTTP wire shape. Servers (arc) call it once before flushing;
 * SDK clients (arc-next) consume the matching `PaginatedResult` type.
 * Discriminate on `'method' in response` — HTTP status discriminates
 * success vs error.
 *
 * Why a runtime function and not "just spread":
 *   - The bare-array branch needs a `{data}` wrapper for consistency.
 *   - Paginated results need a normalized return shape so consumers can
 *     consume one canonical type instead of N kit-specific shapes.
 *   - One function = one place where the wire shape is materialised, so
 *     regressions can't sneak in via per-route hand-rolled wrappers.
 *
 * @example Server flow
 * ```ts
 * import { toCanonicalList } from '@classytic/repo-core/pagination';
 *
 * const result = await userRepo.getAll(query);
 * reply.send(toCanonicalList(result));
 * ```
 *
 * @example Client typing
 * ```ts
 * import type { PaginatedResult } from '@classytic/repo-core/pagination';
 *
 * const res = await fetch('/users').then(r => r.json()) as PaginatedResult<User>;
 * if ('method' in res && res.method === 'offset') { ...res.page... }
 * ```
 */

import type { AnyPaginationResult, BareListResult, PaginatedResult } from './types.js';

/**
 * Type guard: is this value a paginated result envelope (vs a bare array
 * or some other shape)?
 *
 * Checks for the `method` discriminant rather than `Array.isArray` so a
 * paginated result whose `docs` field happens to contain zero items still
 * routes through the paginated branch.
 *
 * Accepts `unknown` (rather than `T[] | AnyPaginationResult<T>`) so wire-
 * boundary callers can guard arbitrary inputs without pre-narrowing — the
 * arc / arc-next response pipeline routinely sees `{ data: unknown[] }`
 * shapes that are neither a bare array nor a paginated result, and forcing
 * those callers to cast first defeats the guard's purpose.
 */
export function isPaginatedResult<TDoc>(input: unknown): input is AnyPaginationResult<TDoc> {
  if (typeof input !== 'object' || input === null || Array.isArray(input)) {
    return false;
  }
  const method = (input as { method?: unknown }).method;
  return method === 'offset' || method === 'keyset' || method === 'aggregate';
}

/**
 * Normalise a list-shaped value into the canonical wire envelope.
 *
 * Overloads keep the return type tight:
 *   - bare array  → {@link BareListResult}
 *   - paginated   → {@link PaginatedResult} (preserves method discriminant)
 *
 * The mutable-array overload widens to `TDoc[]` because that's the most
 * common server input (kit results return `TDoc[]` for `docs`); the
 * readonly overload covers callers passing `readonly TDoc[]`.
 */
export function toCanonicalList<TDoc>(input: TDoc[]): BareListResult<TDoc>;
export function toCanonicalList<TDoc>(input: readonly TDoc[]): BareListResult<TDoc>;
export function toCanonicalList<TDoc, TExtra extends Record<string, unknown>>(
  input: AnyPaginationResult<TDoc, TExtra>,
): PaginatedResult<TDoc, TExtra>;
export function toCanonicalList<TDoc>(
  input: readonly TDoc[] | AnyPaginationResult<TDoc>,
): PaginatedResult<TDoc>;
export function toCanonicalList<TDoc>(
  input: readonly TDoc[] | AnyPaginationResult<TDoc>,
): PaginatedResult<TDoc> {
  if (isPaginatedResult(input)) {
    // Paginated result → wire shape is structurally identical. Spread
    // produces a fresh object so callers can safely mutate without
    // affecting the source.
    return { ...input };
  }
  // Bare array → BareListResult. Cast to mutable for the wire shape;
  // consumers shouldn't mutate the response anyway.
  return { data: [...input] };
}
