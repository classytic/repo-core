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

/** Offset-paginated result envelope. */
export interface OffsetPaginationResult<TDoc> {
  method: 'offset';
  docs: TDoc[];
  page: number;
  limit: number;
  total: number;
  pages: number;
  hasNext: boolean;
  hasPrev: boolean;
}

/** Keyset-paginated result envelope. */
export interface KeysetPaginationResult<TDoc> {
  method: 'keyset';
  docs: TDoc[];
  limit: number;
  hasMore: boolean;
  /** Cursor token for the next page, or `null` when there is none. */
  next: string | null;
}
