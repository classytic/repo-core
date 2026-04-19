/**
 * Portable lookup IR — cross-kit join contract.
 *
 * The same pattern as `AggRequest` + `Filter`: a backend-agnostic shape
 * that every kit compiles to its native primitive. Mongokit emits a
 * `$lookup` aggregation stage; sqlitekit emits a `LEFT JOIN` with
 * `json_object()` / `json_group_array()` projection; pgkit can emit a
 * LATERAL join. Output row shape is identical across backends so
 * application code (especially arc controllers) sees the same payload
 * regardless of the underlying driver.
 *
 * Scope: single-level joins via a `localField` → `foreignField`
 * equality match. Covers the dashboard / detail-view / admin-list
 * cases that drive ~80% of real lookup usage. Out of scope here:
 *
 *   - Nested lookups (lookup-on-a-lookup). Compose at the application
 *     layer or reach for the kit-native escape.
 *   - Pipeline-form `$lookup` with `let` + `pipeline`. Mongo-specific
 *     correlation expressions don't translate to SQL.
 *   - Cross-database joins. Kit-specific and rarely portable.
 *
 * Escape hatches stay kit-native: use mongokit's
 * `aggregatePipeline([{$lookup, ...}])` or sqlitekit's raw Drizzle
 * query builder when the portable shape isn't enough.
 */

import type { Filter } from '../filter/types.js';
import type {
  KeysetPaginationResultCore,
  OffsetPaginationResultCore,
} from '../pagination/types.js';

// ──────────────────────────────────────────────────────────────────────
// Lookup specification
// ──────────────────────────────────────────────────────────────────────

/**
 * Single lookup join. Reads like a `LEFT JOIN from ON from.foreignField
 * = this.localField`, with the joined payload landing on `as`.
 *
 * Kit semantics (identical output shape across all three):
 *
 *   - **mongokit** → `{ $lookup: { from, localField, foreignField, as,
 *     pipeline?: [{ $project: select }] } }`, optionally followed by
 *     `$unwind` when `single` is true.
 *   - **sqlitekit** → `LEFT JOIN "${from}" ON "${from}"."${foreignField}"
 *     = base."${localField}"` with a projected `json_object(...)` or
 *     `json_group_array(json_object(...))` column aliased to `as`.
 *   - **pgkit** (future) → `LEFT JOIN LATERAL (SELECT ... WHERE ...)`
 *     with `row_to_json` / `json_agg`.
 *
 * The `from` value is a string table/collection name — kits resolve it
 * via their registry (Drizzle schema for SQL, mongoose connection for
 * mongokit). Typos fail at query-time with a clear error, not silently.
 */
export interface LookupSpec {
  /**
   * Foreign table / collection name to join against. Must exist in the
   * kit's schema — sqlitekit looks it up in the Drizzle schema map;
   * mongokit resolves to a Model by collection name.
   */
  from: string;

  /** Field on the base row that holds the foreign key. */
  localField: string;

  /** Field on the joined row that matches `localField`. */
  foreignField: string;

  /**
   * Output key where joined data lands. Defaults to `from` when
   * omitted. Keep it explicit in application code — implicit
   * defaults lead to name collisions when the foreign table name
   * isn't a valid JavaScript identifier.
   */
  as?: string;

  /**
   * When true, unwrap the join to a single object (or `null` when no
   * row matches). Use for one-to-one and many-to-one relationships
   * (e.g. a user's single department). Default is `false` — the join
   * produces an array (empty when no rows match), matching
   * one-to-many semantics.
   *
   * Kits implement this via `$unwind: { preserveNullAndEmptyArrays:
   * true }` (mongokit) or a `json_object()` projection that skips the
   * GROUP BY required for array aggregation (sqlitekit).
   */
  single?: boolean;

  /**
   * Project only these fields from the joined row. Accepts either a
   * column-name array (`['id', 'name']`) or a MongoDB-style
   * inclusion/exclusion map (`{ id: 1, name: 1 }`). Kits translate to
   * their native projection primitive.
   *
   * Omitting `select` returns every column from the joined table.
   * Prefer to narrow — it reduces network bytes and prevents
   * accidental leaks of sensitive fields on the joined row.
   */
  select?: readonly string[] | Record<string, 0 | 1>;

  /**
   * Optional pre-join filter on the joined rows. Compiled by the same
   * Filter IR compiler each kit already uses for WHERE / `$match`.
   * Narrows which foreign rows participate in the join — useful for
   * soft-delete (`isNull('deletedAt')`) or status filters
   * (`eq('status', 'active')`) applied to the joined side.
   *
   * NOTE: Applies to the foreign side only; filter the base side via
   * the top-level `filters` on `lookupPopulate`.
   */
  where?: Filter | Record<string, unknown>;
}

// ──────────────────────────────────────────────────────────────────────
// Invocation options
// ──────────────────────────────────────────────────────────────────────

/**
 * Full options bag for `StandardRepo.lookupPopulate`. Same shape as the
 * paginated read surface (`filters`, `sort`, `page`/`after`, `limit`)
 * plus the `lookups` array. Drops straight into arc controllers that
 * already build `PaginationParams` — just add the `lookups` field.
 *
 * Mixing offset vs keyset follows the same auto-detection rule as
 * `getAll`: presence of `page` → offset, presence of `after` → keyset,
 * neither → offset with `page: 1`.
 */
export interface LookupPopulateOptions<TBase = unknown> {
  /**
   * Pre-join filter on the BASE table. Applied as `WHERE` / `$match`
   * before joins run, so tenant scoping + soft-delete plugins compose
   * correctly. Accepts Filter IR nodes or plain literal records; every
   * kit's compiler handles both.
   */
  filters?: Filter | (Partial<TBase> & Record<string, unknown>);

  /** One or more joins. Processed in array order. */
  lookups: readonly LookupSpec[];

  /**
   * Sort spec applied to the base table. Fields from joined rows are
   * NOT sortable through this contract — they require the kit-native
   * path (mongokit's `aggregatePipeline`, sqlitekit's raw query) because
   * cross-kit semantics for sorting on denormalized joined payloads
   * diverge significantly.
   */
  sort?: string | Record<string, 1 | -1>;

  /** 1-indexed page number for offset pagination. Defaults to `1`. */
  page?: number;

  /** Keyset cursor from a prior `next` field. */
  after?: string;

  /** Rows per page. Kit-dependent default (usually 20); capped at 1000. */
  limit?: number;

  /**
   * Base-table column projection. Applied before joins so kits can
   * narrow the SELECT list early. Joined-row projections live on the
   * individual `LookupSpec.select`.
   */
  select?: readonly string[] | Record<string, 0 | 1>;

  /**
   * `'exact'` (default) runs a parallel count query for `total`;
   * `'none'` skips the count entirely — the envelope reports
   * `total: 0`, `pages: 0`, and derives `hasNext` from a `LIMIT N+1`
   * peek on the data query. Use `'none'` for infinite-scroll UI where
   * the total is never rendered.
   */
  countStrategy?: 'exact' | 'none';

  /**
   * Transaction session, same semantics as every other read. Mongokit
   * threads this into the aggregation; SQL kits ignore it when the
   * repo is already bound to a tx via `withTransaction`.
   */
  session?: unknown;
}

// ──────────────────────────────────────────────────────────────────────
// Result envelope
// ──────────────────────────────────────────────────────────────────────

/**
 * Row shape returned by `lookupPopulate`. Each row carries the base
 * document plus one key per `LookupSpec.as` (defaulting to `from`).
 * The joined value is:
 *
 *   - an array of rows for `single: false` / default (one-to-many)
 *   - an object or `null` for `single: true` (one-to-one)
 *
 * `TBase` is the base row type; `TExtra` (defaults to `Record<string,
 * unknown>`) is the aggregate shape of all joined payloads. Apps that
 * want tight typing can supply `TExtra = { department: Department |
 * null }` at the call site; callers that don't care just see
 * `Record<string, unknown>`.
 */
export type LookupRow<
  TBase = Record<string, unknown>,
  TExtra extends Record<string, unknown> = Record<string, unknown>,
> = TBase & TExtra;

/**
 * Paginated result envelope for `lookupPopulate`. Mirrors `getAll`'s
 * discriminated union — same `docs` / `page` / `limit` / `total` /
 * `pages` / `hasNext` / `hasPrev` (offset) or `docs` / `limit` /
 * `hasMore` / `next` (keyset) — so UI code paginates join results
 * with the same primitives whether it's looking at plain documents
 * or joined ones. Narrow on the `method` discriminator:
 *
 * ```ts
 * const result = await repo.lookupPopulate({ ... });
 * if (result.method === 'keyset') {
 *   // result.next, result.hasMore
 * } else {
 *   // result.page, result.total, result.pages
 * }
 * ```
 *
 * Kits that don't implement keyset joins simply never return the
 * keyset variant — TypeScript's narrowing handles either case
 * uniformly so callers don't branch on the kit.
 */
export type LookupPopulateResult<
  TBase = Record<string, unknown>,
  TExtra extends Record<string, unknown> = Record<string, unknown>,
> =
  | OffsetPaginationResultCore<LookupRow<TBase, TExtra>>
  | KeysetPaginationResultCore<LookupRow<TBase, TExtra>>;
