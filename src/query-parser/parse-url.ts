/**
 * URL → ParsedQuery<Filter> parser.
 *
 * Takes a URLSearchParams-shaped input and produces a driver-agnostic
 * ParsedQuery. The grammar is SQL-ish bracket syntax:
 *
 *   ?status=active                     → eq('status', 'active')
 *   ?age[gte]=18&age[lt]=65            → and(gte(age, 18), lt(age, 65))
 *   ?role[in]=admin,editor             → in_('role', ['admin', 'editor'])
 *   ?name[contains]=john               → contains('name', 'john')
 *   ?search=hello&sort=-createdAt      → ParsedQuery with `.search` + sort
 *   ?price[between]=10,100             → between('price', 10, 100)
 *   ?deletedAt[exists]=false           → isNull('deletedAt')
 *
 * Reserved keys (never parsed as filters):
 *   - `page`, `limit`, `after`
 *   - `sort`, `select`, `populate`
 *   - `search`
 *
 * Kits never reimplement this — they import and use it as-is. Arc-next
 * and fluid can also import this to unit-test their URL emission.
 */

import type { Filter } from '../filter/index.js';
import {
  and,
  between,
  contains,
  endsWith,
  eq,
  gt,
  gte,
  iEq,
  in_,
  isNotNull,
  isNull,
  like,
  lt,
  lte,
  ne,
  nin,
  regex,
  startsWith,
  TRUE,
} from '../filter/index.js';
import { coerceList, coerceValue } from './coerce.js';
import type {
  BracketOperator,
  ParsedPopulate,
  ParsedQuery,
  ParsedSelect,
  ParsedSort,
  QueryParserInput,
  QueryParserOptions,
} from './types.js';

const DEFAULT_LIMIT = 20;
const DEFAULT_MAX_LIMIT = 200;
const DEFAULT_MAX_DEPTH = 10;
const DEFAULT_MAX_REGEX = 500;
const DEFAULT_MAX_SEARCH = 200;

/** Reserved top-level URL keys the parser handles specially. */
const RESERVED_KEYS: ReadonlySet<string> = new Set([
  'page',
  'limit',
  'after',
  'sort',
  'select',
  'populate',
  'search',
]);

const ALL_OPERATORS: ReadonlySet<BracketOperator> = new Set([
  'eq',
  'ne',
  'gt',
  'gte',
  'lt',
  'lte',
  'in',
  'nin',
  'like',
  'contains',
  'startsWith',
  'endsWith',
  'ieq',
  'regex',
  'between',
  'exists',
]);

/** Parse URL search params into a driver-agnostic ParsedQuery. */
export function parseUrl(input: QueryParserInput, options: QueryParserOptions = {}): ParsedQuery {
  const params = normalize(input);
  const maxLimit = options.maxLimit ?? DEFAULT_MAX_LIMIT;
  const allowedOps = options.allowedOperators ? new Set(options.allowedOperators) : ALL_OPERATORS;

  // ── Pagination + list-level params ───────────────────────────────────
  const rawPage = params.get('page');
  const rawLimit = params.get('limit');
  const after = params.get('after') ?? undefined;
  const limit = clampLimit(rawLimit, options.defaultLimit ?? DEFAULT_LIMIT, maxLimit);
  const page = rawPage !== null && rawPage !== undefined ? toPositiveInt(rawPage) : undefined;

  // ── Sort ─────────────────────────────────────────────────────────────
  const sort = parseSort(params.get('sort'), options.allowedSortFields);

  // ── Select ───────────────────────────────────────────────────────────
  const select = parseSelect(params.get('select'));

  // ── Populate ─────────────────────────────────────────────────────────
  const populate = parsePopulate(params);

  // ── Search ───────────────────────────────────────────────────────────
  const rawSearch = params.get('search');
  const searchCap = options.maxSearchLength ?? DEFAULT_MAX_SEARCH;
  const search =
    rawSearch !== null && rawSearch !== undefined && rawSearch.length > 0
      ? rawSearch.slice(0, searchCap)
      : undefined;

  // ── Filters ──────────────────────────────────────────────────────────
  const filter = parseFilters(params, {
    allowedFields: options.allowedFilterFields,
    allowedOps,
    fieldTypes: options.fieldTypes,
    maxDepth: options.maxFilterDepth ?? DEFAULT_MAX_DEPTH,
    maxRegex: options.maxRegexLength ?? DEFAULT_MAX_REGEX,
  });

  const result: ParsedQuery = { filter, limit };
  if (sort) result.sort = sort;
  if (select) result.select = select;
  if (populate.length > 0) result.populate = populate;
  if (page !== undefined) result.page = page;
  if (after !== undefined) result.after = after;
  if (search !== undefined) result.search = search;
  return result;
}

// ──────────────────────────────────────────────────────────────────────
// Internals
// ──────────────────────────────────────────────────────────────────────

interface FilterParseContext {
  allowedFields: readonly string[] | undefined;
  allowedOps: ReadonlySet<BracketOperator>;
  fieldTypes: QueryParserOptions['fieldTypes'];
  maxDepth: number;
  maxRegex: number;
}

interface NormalizedParams {
  get(key: string): string | null;
  /** Iterates every param, returning both single values and array-split ones. */
  entries(): Iterable<[string, string]>;
  /** True if the key was provided (even with empty string). */
  has(key: string): boolean;
}

function normalize(input: QueryParserInput): NormalizedParams {
  if (input instanceof URLSearchParams) {
    return {
      get: (k) => input.get(k),
      entries: () => input.entries(),
      has: (k) => input.has(k),
    };
  }
  if (Symbol.iterator in (input as object)) {
    const usp = new URLSearchParams();
    for (const [k, v] of input as Iterable<[string, string]>) usp.append(k, v);
    return {
      get: (k) => usp.get(k),
      entries: () => usp.entries(),
      has: (k) => usp.has(k),
    };
  }
  const record = input as Record<string, string | string[] | undefined>;
  const usp = new URLSearchParams();
  for (const [k, v] of Object.entries(record)) {
    if (v === undefined) continue;
    if (Array.isArray(v)) for (const item of v) usp.append(k, item);
    else usp.append(k, v);
  }
  return {
    get: (k) => usp.get(k),
    entries: () => usp.entries(),
    has: (k) => usp.has(k),
  };
}

function clampLimit(raw: string | null, fallback: number, max: number): number {
  if (raw === null || raw === undefined) return fallback;
  const n = Number(raw);
  if (!Number.isFinite(n) || n < 1) return fallback;
  return Math.min(Math.floor(n), max);
}

function toPositiveInt(raw: string): number | undefined {
  const n = Number(raw);
  if (!Number.isFinite(n) || n < 1) return undefined;
  return Math.floor(n);
}

function parseSort(raw: string | null, allowed?: readonly string[]): ParsedSort | undefined {
  if (!raw) return undefined;
  const spec: ParsedSort = {};
  for (const piece of raw
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean)) {
    const desc = piece.startsWith('-');
    const field = desc ? piece.slice(1) : piece.startsWith('+') ? piece.slice(1) : piece;
    if (allowed && !allowed.includes(field)) continue;
    spec[field] = desc ? -1 : 1;
  }
  return Object.keys(spec).length > 0 ? spec : undefined;
}

function parseSelect(raw: string | null): ParsedSelect | undefined {
  if (!raw) return undefined;
  const spec: ParsedSelect = {};
  for (const piece of raw
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean)) {
    if (piece.startsWith('-')) {
      spec[piece.slice(1)] = 0;
    } else {
      spec[piece] = 1;
    }
  }
  return Object.keys(spec).length > 0 ? spec : undefined;
}

/**
 * Parse `populate[field][select]=...&populate[field][match][other]=...` into
 * an array of ParsedPopulate specs. Flat iteration keeps the parser simple;
 * nested populate (`populate[author][populate][org][select]=...`) is supported
 * one level deep.
 */
function parsePopulate(params: NormalizedParams): ParsedPopulate[] {
  // Collect keys that start with `populate[...]`
  const byField: Map<string, { select?: string; match?: Record<string, unknown> }> = new Map();
  for (const [key, value] of params.entries()) {
    if (!key.startsWith('populate[')) continue;
    const match = /^populate\[([^\]]+)\](?:\[([^\]]+)\](?:\[([^\]]+)\])?)?$/.exec(key);
    if (!match) continue;
    const [, field, sub, subKey] = match;
    if (!field) continue;
    const existing = byField.get(field) ?? {};
    if (!sub) {
      // populate[author] with a value — unused in this flat form; ignore.
      byField.set(field, existing);
    } else if (sub === 'select') {
      existing.select = value;
      byField.set(field, existing);
    } else if (sub === 'match' && subKey) {
      existing.match = existing.match ?? {};
      existing.match[subKey] = value;
      byField.set(field, existing);
    }
  }
  const out: ParsedPopulate[] = [];
  for (const [path, spec] of byField) {
    const entry: ParsedPopulate = { path };
    if (spec.select !== undefined) entry.select = spec.select;
    if (spec.match) entry.match = spec.match;
    out.push(entry);
  }
  return out;
}

function parseFilters(params: NormalizedParams, ctx: FilterParseContext): Filter {
  const leaves: Filter[] = [];
  // Collate `field[op]=v` entries into groups keyed by field, so
  // multiple predicates on the same field become one AND.
  const fieldGroups: Map<string, Filter[]> = new Map();

  for (const [key, rawValue] of params.entries()) {
    if (RESERVED_KEYS.has(key) || key.startsWith('populate[')) continue;

    const bracket = /^([^[\]]+)\[([^\]]+)\]$/.exec(key);
    let field: string;
    let op: BracketOperator;
    if (bracket) {
      const [, f, o] = bracket;
      if (!f || !o) continue;
      field = f;
      op = o as BracketOperator;
    } else {
      field = key;
      op = 'eq';
    }
    if (ctx.allowedFields && !ctx.allowedFields.includes(field)) continue;
    if (!ctx.allowedOps.has(op)) continue;

    const fieldType = ctx.fieldTypes?.[field];
    const leaf = buildLeaf(field, op, rawValue, fieldType, ctx);
    if (!leaf) continue;

    const bucket = fieldGroups.get(field) ?? [];
    bucket.push(leaf);
    fieldGroups.set(field, bucket);
  }

  for (const [, nodes] of fieldGroups) {
    if (nodes.length === 1) {
      leaves.push(nodes[0] as Filter);
    } else {
      leaves.push(and(...nodes));
    }
  }

  if (leaves.length === 0) return TRUE;
  if (leaves.length === 1) return leaves[0] as Filter;
  return and(...leaves);
}

function buildLeaf(
  field: string,
  op: BracketOperator,
  rawValue: string,
  fieldType: FilterParseContext['fieldTypes'] extends infer T
    ? T extends Record<string, infer V>
      ? V | undefined
      : undefined
    : undefined,
  ctx: FilterParseContext,
): Filter | undefined {
  switch (op) {
    case 'eq':
      return eq(field, coerceValue(rawValue, fieldType));
    case 'ne':
      return ne(field, coerceValue(rawValue, fieldType));
    case 'gt':
      return gt(field, coerceValue(rawValue, fieldType));
    case 'gte':
      return gte(field, coerceValue(rawValue, fieldType));
    case 'lt':
      return lt(field, coerceValue(rawValue, fieldType));
    case 'lte':
      return lte(field, coerceValue(rawValue, fieldType));
    case 'in':
      return in_(field, coerceList(rawValue, fieldType));
    case 'nin':
      return nin(field, coerceList(rawValue, fieldType));
    case 'like':
      return like(field, rawValue);
    case 'contains':
      return contains(field, rawValue);
    case 'startsWith':
      return startsWith(field, rawValue);
    case 'endsWith':
      return endsWith(field, rawValue);
    case 'ieq':
      return iEq(field, rawValue);
    case 'regex': {
      if (rawValue.length > ctx.maxRegex) return undefined;
      return regex(field, rawValue);
    }
    case 'between': {
      const parts = coerceList(rawValue, fieldType);
      if (parts.length < 2) return undefined;
      return between(field, parts[0], parts[1]);
    }
    case 'exists': {
      const val = rawValue.toLowerCase();
      const present = val === 'true' || val === '1';
      return present ? isNotNull(field) : isNull(field);
    }
  }
}
