/**
 * Canonical list-envelope normalizer.
 *
 * `toCanonicalList(input)` accepts any of:
 *   - `T[]` / `readonly T[]` — bare array (an endpoint that doesn't paginate)
 *   - {@link OffsetPaginationResult} / {@link KeysetPaginationResult} /
 *     {@link AggregatePaginationResult} — anything a `RepositoryLike` returns
 *
 * and emits the matching {@link PaginatedResponse} wire envelope (with
 * `success: true` stamped on). The `method` discriminant on paginated
 * results carries straight through; bare arrays produce a
 * {@link BareListResponse}.
 *
 * This is the single point where the *internal* repo result becomes the
 * *external* HTTP envelope. Servers (arc) call it once before flushing;
 * SDK clients (arc-next) consume the matching `PaginatedResponse` type.
 *
 * Why a runtime function and not "just spread":
 *   - The bare-array branch needs a wrapper.
 *   - Paginated results need `success: true` stamped without losing the
 *     `method` discriminant or `TExtra` fields.
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
 * import type { PaginatedResponse } from '@classytic/repo-core/pagination';
 *
 * const res = await fetch('/users').then(r => r.json()) as PaginatedResponse<User>;
 * if (res.method === 'offset') { ...res.page... }
 * ```
 */

import type { AnyPaginationResult, BareListResponse, PaginatedResponse } from './types.js';

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
 * arc / arc-next response pipeline routinely sees `{ docs: unknown[] }`
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
 *   - bare array  → {@link BareListResponse}
 *   - paginated   → {@link PaginatedResponse} (preserves method discriminant)
 *
 * The mutable-array overload widens to `TDoc[]` because that's the most
 * common server input (kit results return `TDoc[]` for `docs`); the
 * readonly overload covers callers passing `readonly TDoc[]`.
 */
export function toCanonicalList<TDoc>(input: TDoc[]): BareListResponse<TDoc>;
export function toCanonicalList<TDoc>(input: readonly TDoc[]): BareListResponse<TDoc>;
export function toCanonicalList<TDoc, TExtra extends Record<string, unknown>>(
  input: AnyPaginationResult<TDoc, TExtra>,
): PaginatedResponse<TDoc, TExtra>;
export function toCanonicalList<TDoc>(
  input: readonly TDoc[] | AnyPaginationResult<TDoc>,
): PaginatedResponse<TDoc>;
export function toCanonicalList<TDoc>(
  input: readonly TDoc[] | AnyPaginationResult<TDoc>,
): PaginatedResponse<TDoc> {
  if (isPaginatedResult(input)) {
    // `success: true` goes AFTER the spread so a stale `success: false`
    // accidentally present on the input cannot override the literal —
    // the canonical wire contract for the paginated success path is
    // `success: true` regardless of what's on the result object. Tested.
    return { ...input, success: true };
  }
  // Bare array → BareListResponse. Cast to mutable for the wire shape;
  // consumers shouldn't mutate the response anyway.
  return { success: true, docs: [...input] };
}
