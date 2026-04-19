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

/**
 * Configuration knobs for the parser. All optional — sane defaults cover
 * typical arc use cases.
 */
export interface QueryParserOptions {
  /** Default per-page count when the URL omits `limit`. Default: 20. */
  defaultLimit?: number;
  /** Hard cap on `limit` to prevent resource exhaustion. Default: 200. */
  maxLimit?: number;
  /** Allowlist of filter field names. When set, unknown fields are dropped. */
  allowedFilterFields?: readonly string[];
  /** Allowlist of sort field names. When set, unknown fields are dropped. */
  allowedSortFields?: readonly string[];
  /** Allowlist of operator names accepted in bracket syntax. */
  allowedOperators?: readonly BracketOperator[];
  /** Max filter nesting depth (defends against filter-bomb URLs). Default: 10. */
  maxFilterDepth?: number;
  /** Regex pattern length cap (ReDoS defense). Default: 500. */
  maxRegexLength?: number;
  /** Search query length cap. Default: 200. */
  maxSearchLength?: number;
  /**
   * Field-type hints for value coercion. When a filter field is in this
   * map, the URL string value is coerced to the declared type:
   *   - `'number'`  → `Number(value)`
   *   - `'boolean'` → `'true'`/`'1'` → true, else false
   *   - `'date'`    → `new Date(value)` (validated)
   *   - `'string'`  → left as-is (default for unlisted fields)
   *
   * Use this to avoid the heuristic coercion's footguns (e.g. `?sku=12345`
   * against a string SKU column — without a hint, heuristics turn it into
   * a number and the SQL comparison fails).
   */
  fieldTypes?: Record<string, 'string' | 'number' | 'boolean' | 'date'>;
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
  | 'exists';

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
