/**
 * QueryParser public types.
 *
 * These shapes are the **cross-cutting contract** between every layer:
 * the URL (arc-next's `useBaseSearch`, fluid's `filter-utils`), the
 * QueryParser (`@classytic/repo-core/query-parser`), each kit's
 * compiler, and arc's BaseController. Stability here unlocks upgrades
 * without rewiring anything.
 *
 * Convention: URL params use SQL-ish bracket operators (`field[gte]=10`,
 * `field[in]=a,b`, `field[like]=%john%`). The parser converts these to
 * repo-core Filter IR. Kits compile the IR to native syntax. Frontends
 * emit the bracket grammar.
 */

import type { Filter } from '../filter/index.js';
import type { QueryFieldType } from './coerce.js';

/** Sort direction on a single field. */
export type ParsedSortDirection = 1 | -1;

/** Sort spec after parsing — array so field order is preserved. */
export type ParsedSort = Record<string, ParsedSortDirection>;

/** Projection — field inclusion/exclusion map (`1` include, `0` exclude). */
export type ParsedSelect = Record<string, 0 | 1>;

/**
 * Populate / include spec for relation fetching. Kits interpret per backend:
 *
 * - mongokit compiles to Mongoose `populate()`
 * - sqlitekit uses it as a hint for JOIN generation (future)
 * - prismakit compiles to `include: {...}`
 *
 * Frontends pass it through from URL `populate[field][select]=...`
 * params; the shape matches mongoose's `PopulateOptions`.
 */
export interface ParsedPopulate {
  path: string;
  select?: string;
  match?: Record<string, unknown>;
  options?: { limit?: number; sort?: ParsedSort; skip?: number };
  populate?: ParsedPopulate;
}

/**
 * Canonical parsed-query envelope. Every kit receives this shape, every
 * frontend emits URLs that produce it, arc's BaseController threads it
 * into repo calls. **Do not add kit-specific fields here** — kits extend
 * their own options types for native-only features.
 */
export interface ParsedQuery {
  /** Filter IR tree. Always present (TRUE when no filter params). */
  filter: Filter;
  /** Optional sort spec. When absent, kits apply their default sort. */
  sort?: ParsedSort;
  /** Field projection. */
  select?: ParsedSelect;
  /** Relation population (when the kit supports it). */
  populate?: ParsedPopulate[];
  /** 1-indexed page. Present only when the URL used offset-pagination params. */
  page?: number;
  /** Opaque cursor from a prior `next`. Present only on keyset requests. */
  after?: string;
  /** Per-page item count. */
  limit: number;
  /** Free-text search term (kits interpret per backend — $text, FTS, etc.). */
  search?: string;
}

/** Parser knobs. Every allowlist REFUSES (400) what it does not name — never drops it. */
export interface QueryParserOptions {
  /** Per-page count when the URL omits `limit`. Default: 20. */
  defaultLimit?: number;
  /** Cap on `limit`; a larger request is clamped to it. Default: 1000. */
  maxLimit?: number;
  /** Filterable fields. */
  allowedFilterFields?: readonly string[];
  /** Sortable fields. */
  allowedSortFields?: readonly string[];
  /** URL operator names permitted in `field[op]`. */
  allowedOperators?: readonly BracketOperator[];
  /** Longest text-operator value or regex pattern. Default: 500. */
  maxRegexLength?: number;
  /** Longest `search`. Default: 200. */
  maxSearchLength?: number;
  /**
   * Declared field types — exact coercion, and a value that does not fit is refused. Without one,
   * the grammar's conservative heuristic applies (see `coerceQueryValue`).
   */
  fieldTypes?: Record<string, QueryFieldType>;
}

/**
 * Bracket operators accepted in URL syntax. When you see `field[op]=value`
 * in a URL, `op` is one of these. Kept as a closed set — new operators
 * require a new version.
 */
export type BracketOperator =
  | 'eq'
  | 'ne'
  | 'gt'
  | 'gte'
  | 'lt'
  | 'lte'
  | 'in'
  | 'nin'
  | 'like'
  | 'contains'
  | 'startsWith'
  | 'endsWith'
  | 'ieq'
  | 'regex'
  | 'between'
  | 'exists'
  /** Flags for the `regex` on the same field (`i`, `m`, `s`, `x`). */
  | 'options';

/**
 * Input shape for `parseUrl`. URL search params can be sourced from
 * `URLSearchParams.entries()`, Fastify's `request.query`, or
 * Express's `req.query` — all of these produce a `Record<string, string | string[]>`
 * or a compatible iterable. The parser normalizes.
 */
export type QueryParserInput =
  | URLSearchParams
  | Record<string, string | string[] | undefined>
  | Iterable<[string, string]>;
