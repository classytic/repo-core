/**
 * Pagination primitives — driver-agnostic type surface.
 *
 * These types are the vocabulary shared between arc, the driver kits,
 * and any consumer that talks to a repository. Kits extend with their
 * own option types (e.g. mongokit adds `populate`, `collation`); those
 * extensions never change the shape of the result envelope.
 */

/** Ascending (1) or descending (-1). */
export type SortDirection = 1 | -1;

/** Sort specification keyed by field path. */
export type SortSpec = Record<string, SortDirection>;

/** Global pagination configuration, configured once per repository. */
export interface PaginationConfig {
  /** Default documents per page when caller omits `limit`. Default: 10. */
  defaultLimit?: number;
  /** Hard ceiling for `limit`. `0` means unlimited. Default: 100. */
  maxLimit?: number;
  /** Hard ceiling for `page`. Throws above this. Default: 10_000. */
  maxPage?: number;
  /** Page index that triggers a deep-pagination warning. Default: 100. */
  deepPageThreshold?: number;
  /** Cursor version — bump when the payload format changes. Default: 1. */
  cursorVersion?: number;
  /**
   * Minimum cursor version accepted. Bump alongside `cursorVersion` when a
   * breaking format change ships so stale client cursors are rejected with
   * a clear error rather than silently resuming from the wrong position.
   */
  minCursorVersion?: number;
  /**
   * Allowlist of primary sort fields for keyset pagination. When set, any
   * keyset request whose primary (non-`_id`) sort field isn't listed throws
   * at validation time. Use this to lock keyset sorts to fields your schema
   * guarantees non-null — keyset across null/non-null boundaries is lossy.
   *
   * `_id` is always allowed regardless of this list.
   */
  strictKeysetSortFields?: string[];
}

/**
 * Known value types that round-trip through a cursor.
 *
 * `objectid` / `uuid` are NOT in this core union — repo-core is driver-free,
 * so it treats any non-primitive string id as a plain `string`. Kits that
 * need typed id rehydration (mongokit wants real `ObjectId` instances) can
 * tag their own type in the payload and post-process on decode. Unknown
 * tags round-trip unchanged as strings.
 */
export type ValueType = 'date' | 'boolean' | 'number' | 'string' | 'null' | 'unknown';

/** Raw cursor payload — the base64url JSON blob behind a cursor token. */
export interface CursorPayload {
  /** Primary sort field value (legacy single-field compatibility). */
  v: string | number | boolean | null;
  /** Primary sort field value type tag. Open string so kits can extend. */
  t: string;
  /** Document id, serialized as string. */
  id: string;
  /** Document id type tag. Open string so kits can extend (e.g. `objectid`). */
  idType: string;
  /** Sort specification this cursor was built against. */
  sort: SortSpec;
  /** Cursor format version. */
  ver: number;
  /** Compound sort field values (multi-field keyset). */
  vals?: Record<string, string | number | boolean | null>;
  /** Compound sort value type tags. */
  types?: Record<string, string>;
}

/** Decoded cursor with values rehydrated to their declared types. */
export interface DecodedCursor {
  /** Primary sort field value (rehydrated). */
  value: unknown;
  /** Document id (rehydrated — string for unknown id types). */
  id: unknown;
  /** Sort specification. */
  sort: SortSpec;
  /** Cursor format version. */
  version: number;
  /** Compound sort field values (rehydrated). Present when the cursor was built from a multi-field sort. */
  values?: Record<string, unknown>;
}

/**
 * Core fields of an offset-paginated result. Don't consume this directly —
 * use `OffsetPaginationResult<TDoc>` or `OffsetPaginationResult<TDoc, TExtra>`.
 */
export interface OffsetPaginationResultCore<TDoc> {
  method: 'offset';
  data: TDoc[];
  page: number;
  limit: number;
  total: number;
  pages: number;
  hasNext: boolean;
  hasPrev: boolean;
}

/**
 * Offset-paginated result envelope.
 *
 * `TExtra` lets kits surface typed extras alongside the core envelope —
 * mongokit emits `warning?: string` on deep-page reads, pgkit could surface
 * `queryPlan`, sqlitekit could surface vacuum hints. Defaults to `{}` so
 * consumers that don't care see zero change (`OffsetPaginationResult<User>`
 * behaves exactly as before).
 *
 * The `method: 'offset'` discriminant carries through the intersection so
 * `if (result.method === 'offset')` narrowing keeps working.
 *
 * @example Kit extends with typed extras
 * ```ts
 * type MongokitPage<T> = OffsetPaginationResult<T, { warning?: string }>;
 * ```
 */
export type OffsetPaginationResult<
  TDoc,
  // biome-ignore lint/complexity/noBannedTypes: `{}` is intentional as the "no extras" default — `Record<string, never>` over-constrains the intersection and forces core fields to `never`.
  TExtra extends Record<string, unknown> = {},
> = OffsetPaginationResultCore<TDoc> & TExtra;

/**
 * Core fields of a keyset-paginated result. Don't consume this directly —
 * use `KeysetPaginationResult<TDoc>` or `KeysetPaginationResult<TDoc, TExtra>`.
 */
export interface KeysetPaginationResultCore<TDoc> {
  method: 'keyset';
  data: TDoc[];
  limit: number;
  hasMore: boolean;
  /** Cursor token for the next page, or `null` when there is none. */
  next: string | null;
}

/**
 * Keyset-paginated result envelope.
 *
 * `TExtra` parallels `OffsetPaginationResult` — see that type's docstring
 * for the rationale. Defaults to `{}`.
 */
export type KeysetPaginationResult<
  TDoc,
  // biome-ignore lint/complexity/noBannedTypes: see `OffsetPaginationResult` for the rationale — `Record<string, never>` over-constrains the intersection.
  TExtra extends Record<string, unknown> = {},
> = KeysetPaginationResultCore<TDoc> & TExtra;

/**
 * Core fields of an aggregate-paginated result. Don't consume this directly —
 * use `AggregatePaginationResult<TDoc>` or `AggregatePaginationResult<TDoc, TExtra>`.
 *
 * Aggregate pagination produces page-shaped envelopes from arbitrary aggregate
 * pipelines (mongokit's `aggregatePaginate` / `aggregatePipelinePaginate`,
 * pgkit's CTE-based windowed counts, etc). The shape mirrors offset because
 * the math is the same — the discriminant exists so consumers can route
 * "this came from an aggregate, not a plain find" without inspecting the
 * pipeline.
 */
export interface AggregatePaginationResultCore<TDoc> {
  method: 'aggregate';
  data: TDoc[];
  page: number;
  limit: number;
  total: number;
  pages: number;
  hasNext: boolean;
  hasPrev: boolean;
}

/**
 * Aggregate-paginated result envelope.
 *
 * `TExtra` parallels `OffsetPaginationResult` — kits surface deep-pagination
 * warnings (`warning?: string`), aggregate-specific stats, etc.
 */
export type AggregatePaginationResult<
  TDoc,
  // biome-ignore lint/complexity/noBannedTypes: see `OffsetPaginationResult` for the rationale.
  TExtra extends Record<string, unknown> = {},
> = AggregatePaginationResultCore<TDoc> & TExtra;

/**
 * Union of every pagination *result* shape (server-side, pre-wire).
 *
 * What kits return from `getAll` / `aggregatePaginate`. Use this as the
 * input type to anything that converts repo results into HTTP envelopes —
 * see {@link toCanonicalList}.
 */
export type AnyPaginationResult<
  TDoc,
  // biome-ignore lint/complexity/noBannedTypes: see `OffsetPaginationResult` for the rationale.
  TExtra extends Record<string, unknown> = {},
> =
  | OffsetPaginationResult<TDoc, TExtra>
  | KeysetPaginationResult<TDoc, TExtra>
  | AggregatePaginationResult<TDoc, TExtra>;

// ============================================================================
// Bare list + full-union shapes
// ============================================================================
//
// Pagination shapes (`OffsetPaginationResult`, `KeysetPaginationResult`,
// `AggregatePaginationResult`) above are the canonical types kits return
// from `getAll` / `aggregatePaginate` AND what the HTTP wire emits — the
// data shape and wire shape are intentionally identical (no envelope; HTTP
// status discriminates success vs error, `ErrorContract` covers errors).
//
// `BareListResult` covers the additional case of an endpoint that doesn't
// paginate (raw array wrapped in `{data}`). `PaginatedResult` is the union
// of all four — what arc emits for any list endpoint, what arc-next types
// against. Discriminate via `'method' in result`.

/**
 * Bare list shape — an endpoint that doesn't paginate (raw array wrapped
 * in `{data}` for consistency with paginated shapes). Consumers narrow on
 * the absence of `method`. The `{data}` wrapper (vs returning the raw
 * array) leaves room to add pagination metadata later without breaking
 * the consumer contract.
 */
export interface BareListResult<TDoc> {
  data: TDoc[];
}

/**
 * Union of every list shape an endpoint can emit — paginated (offset,
 * keyset, aggregate) OR bare (`{data}` only). Discriminate via
 * `'method' in result` — `method === 'offset' | 'keyset' | 'aggregate'`
 * for paginated, absent for bare lists. Errors live on a separate path
 * (HTTP status >= 400 → `ErrorContract`).
 */
export type PaginatedResult<
  TDoc,
  // biome-ignore lint/complexity/noBannedTypes: see `OffsetPaginationResult` for the rationale.
  TExtra extends Record<string, unknown> = {},
> =
  | OffsetPaginationResult<TDoc, TExtra>
  | KeysetPaginationResult<TDoc, TExtra>
  | AggregatePaginationResult<TDoc, TExtra>
  | BareListResult<TDoc>;
