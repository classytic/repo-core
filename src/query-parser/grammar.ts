/**
 * THE list-query grammar. Every parser — repo-core `parseUrl`, arc's `ArcQueryParser`, mongokit's
 * `QueryParser` — reads a request through these functions and differs only in what it EMITS;
 * `runQueryGrammarConformance` (`@classytic/repo-core/testing`) holds them to the same rows.
 *
 * - A filter key is `field` or `field[op]`; `field` is a dot path. Anything else is refused.
 * - Operators are closed ({@link CORE_OPERATORS}, plus `like` = `contains`, `between=a,b` =
 *   `gte a` AND `lte b`, and `options` flags on a `regex`); a kit adds its own via
 *   `extensionOperators`. Text operators match LITERAL text case-insensitively; only `regex` is a
 *   pattern. `ne`/`nin`/`exists` follow the Filter IR: null and missing never equal a value.
 * - `status=a&status=b` means `in`; clauses on one field AND. An empty value is no filter.
 * - Invalid input throws {@link QueryGrammarError} (400): a dropped filter WIDENS the read.
 */

import type { Filter } from '../filter/index.js';
import {
  and,
  contains,
  endsWith,
  eq,
  exists,
  gt,
  gte,
  iEq,
  in_,
  lt,
  lte,
  ne,
  nin,
  regex,
  startsWith,
  TRUE,
} from '../filter/index.js';
import { coerceQueryValue, type QueryFieldType, type QueryScalar } from './coerce.js';
import { type QueryErrorKind, QueryGrammarError } from './errors.js';
import { assessRegex } from './regex-safety.js';
import { STANDARD_RESERVED_PARAMS } from './reserved.js';
import type { BracketOperator, ParsedSelect, ParsedSort } from './types.js';

export const DEFAULT_LIMIT = 20;
export const DEFAULT_MAX_LIMIT = 1000;
export const DEFAULT_MAX_TEXT_LENGTH = 500;
export const DEFAULT_MAX_SEARCH_LENGTH = 200;
const MAX_KEY_LENGTH = 256;
/** Deepest qs nesting a filter can have: `filter[field][op]` plus a repeated value. */
const MAX_NESTING = 4;

export const CORE_OPERATORS = [
  'eq',
  'ne',
  'gt',
  'gte',
  'lt',
  'lte',
  'in',
  'nin',
  'exists',
  'contains',
  'startsWith',
  'endsWith',
  'ieq',
  'regex',
] as const;
export type CoreOperator = (typeof CORE_OPERATORS)[number];

/**
 * URL operator names the grammar accepts: the core set plus its sugar. Keyed by `BracketOperator`
 * so the public type and the runtime list cannot drift — a missing or extra name is a compile error.
 */
const URL_OPERATOR_SET: Readonly<Record<BracketOperator, true>> = {
  ...(Object.fromEntries(CORE_OPERATORS.map((op) => [op, true])) as Record<CoreOperator, true>),
  like: true,
  between: true,
  options: true,
};
export const URL_OPERATORS: readonly BracketOperator[] = Object.keys(
  URL_OPERATOR_SET,
) as BracketOperator[];

/** One line per URL operator — the single source for every parser's OpenAPI description. */
export const OPERATOR_DESCRIPTIONS: Readonly<Record<BracketOperator, string>> = {
  eq: 'Equal (the default for `field=value`; repeated keys mean `in`)',
  ne: 'Not equal — null and missing values never match',
  gt: 'Greater than',
  gte: 'Greater than or equal',
  lt: 'Less than',
  lte: 'Less than or equal',
  in: 'One of a comma-separated list',
  nin: 'None of a comma-separated list — null and missing values never match',
  exists: 'Has a non-null value (true) / is null or missing (false)',
  contains: 'Contains the text (literal, case-insensitive)',
  like: 'Alias of contains',
  startsWith: 'Starts with the text (literal, case-insensitive)',
  endsWith: 'Ends with the text (literal, case-insensitive)',
  ieq: 'Equals the text, ignoring case',
  regex: 'Regular expression (case-sensitive; checked for ReDoS)',
  options: 'Flags for the regex on the same field (i, m, s, x)',
  between: 'Inclusive range `from,to` (either side may be empty)',
};

const FIELD = '[A-Za-z_][A-Za-z0-9_-]*(?:\\.[A-Za-z0-9_-]+)*';
const FIELD_RE = new RegExp(`^${FIELD}$`);
const FILTER_KEY_RE = new RegExp(`^(${FIELD})(?:\\[([A-Za-z]+)\\])?$`);
const SORT_TOKEN_RE = new RegExp(`^([+-]?)(${FIELD})$`);
const SELECT_TOKEN_RE = new RegExp(`^(-?)(${FIELD})$`);
const REGEX_FLAGS_RE = /^[imsx]+$/;

export type FilterClause =
  | {
      readonly field: string;
      readonly op: 'eq' | 'ne' | 'gt' | 'gte' | 'lt' | 'lte';
      readonly value: QueryScalar;
    }
  | { readonly field: string; readonly op: 'in' | 'nin'; readonly values: readonly QueryScalar[] }
  | { readonly field: string; readonly op: 'exists'; readonly value: boolean }
  | {
      readonly field: string;
      readonly op: 'contains' | 'startsWith' | 'endsWith' | 'ieq';
      readonly text: string;
    }
  | {
      readonly field: string;
      readonly op: 'regex';
      readonly pattern: string;
      readonly flags?: string;
    };

/** A kit-declared operator (geo, `size`, …), handed back raw for the kit to emit natively. */
export interface ExtensionClause {
  readonly field: string;
  readonly op: string;
  readonly raw: string;
}

export interface QueryGrammarOptions {
  /** Filterable fields; any other field is refused. */
  allowedFilterFields?: readonly string[] | undefined;
  /** URL operator names permitted (`options` follows `regex`); any other is refused. */
  allowedOperators?: readonly string[] | undefined;
  /** Declared field types — exact coercion, and a value that does not fit is refused. */
  fieldTypes?: Readonly<Record<string, QueryFieldType>> | undefined;
  /** Operators the kit emits itself; returned as {@link ExtensionClause}s. */
  extensionOperators?: readonly string[] | undefined;
  /** Kit-local control params (beyond `STANDARD_RESERVED_PARAMS`) that are not filters. */
  reservedParams?: readonly string[] | undefined;
  /** Longest text-operator value or regex pattern. Default {@link DEFAULT_MAX_TEXT_LENGTH}. */
  maxTextLength?: number | undefined;
  /**
   * Drop mode: called with each refusal and the offending entry is skipped instead of thrown.
   * Dropping a filter WIDENS the read — for trusted compatibility tooling only.
   */
  onInvalid?: ((error: QueryGrammarError) => void) | undefined;
}

export interface FilterReadResult {
  readonly clauses: FilterClause[];
  readonly extensions: ExtensionClause[];
}

/** A list query as a parser receives it: URL params, qs-nested objects, or flat records. */
export type QueryInput =
  | URLSearchParams
  | Iterable<readonly [string, string]>
  | Readonly<Record<string, unknown>>;

// ──────────────────────────────────────────────────────────────────────
// Filters
// ──────────────────────────────────────────────────────────────────────

/** Read every filter in `input` as canonical clauses. */
export function readFilterClauses(
  input: QueryInput | null | undefined,
  options: QueryGrammarOptions = {},
): FilterReadResult {
  const reserved = new Set([...STANDARD_RESERVED_PARAMS, ...(options.reservedParams ?? [])]);
  const extensions = new Set(options.extensionOperators ?? []);
  const allowedOps = options.allowedOperators ? new Set(options.allowedOperators) : undefined;
  const allowedFields = options.allowedFilterFields
    ? new Set(options.allowedFilterFields)
    : undefined;
  const maxText = options.maxTextLength ?? DEFAULT_MAX_TEXT_LENGTH;

  const clauses: FilterClause[] = [];
  const extensionClauses: ExtensionClause[] = [];
  const regexFlags = new Map<string, string>();

  const guard = (fn: () => void): void => {
    try {
      fn();
    } catch (error) {
      if (!(error instanceof QueryGrammarError) || !options.onInvalid) throw error;
      options.onInvalid(error);
    }
  };

  for (const [key, value] of filterEntries(toRecord(input), reserved)) {
    guard(() => {
      const raw = toRaw(key, value);
      if (raw === '') return;
      const { field, op, explicit } = parseFilterKey(key, extensions);
      if (allowedFields && !allowedFields.has(field)) {
        throw new QueryGrammarError(key, `"${field}" is not a filterable field`, 'policy');
      }
      const gate = op === 'options' ? 'regex' : op;
      // `field=value` is not an operator use; only an explicit `field[op]` is gated.
      if (explicit && allowedOps && !allowedOps.has(gate)) {
        throw new QueryGrammarError(key, `operator "${op}" is not allowed`, 'policy');
      }
      if (extensions.has(op)) {
        extensionClauses.push({ field, op, raw });
        return;
      }
      if (op === 'options') {
        if (!REGEX_FLAGS_RE.test(raw))
          throw new QueryGrammarError(key, 'flags must be from i, m, s, x');
        regexFlags.set(field, raw);
        return;
      }
      const fieldType = options.fieldTypes?.[field];
      clauses.push(...toClauses(key, field, op, raw, fieldType, maxText));
    });
  }

  for (const [field, flags] of regexFlags) {
    guard(() => {
      const index = clauses.findIndex((c) => c.field === field && c.op === 'regex');
      if (index < 0)
        throw new QueryGrammarError(`${field}[options]`, 'needs a regex on the same field');
      const clause = clauses[index] as Extract<FilterClause, { op: 'regex' }>;
      clauses[index] = { ...clause, flags };
    });
  }

  return { clauses: collapseRepeats(clauses), extensions: extensionClauses };
}

/** Canonical clauses → the portable Filter IR (repeated fields AND). */
export function clausesToFilter(clauses: readonly FilterClause[]): Filter {
  const nodes = clauses.map(clauseToFilter);
  if (nodes.length === 0) return TRUE;
  return nodes.length === 1 ? (nodes[0] as Filter) : and(...nodes);
}

function clauseToFilter(clause: FilterClause): Filter {
  switch (clause.op) {
    case 'eq':
      return eq(clause.field, clause.value);
    case 'ne':
      return ne(clause.field, clause.value);
    case 'gt':
      return gt(clause.field, clause.value);
    case 'gte':
      return gte(clause.field, clause.value);
    case 'lt':
      return lt(clause.field, clause.value);
    case 'lte':
      return lte(clause.field, clause.value);
    case 'in':
      return in_(clause.field, clause.values);
    case 'nin':
      return nin(clause.field, clause.values);
    case 'exists':
      return exists(clause.field, clause.value);
    case 'contains':
      return contains(clause.field, clause.text);
    case 'startsWith':
      return startsWith(clause.field, clause.text);
    case 'endsWith':
      return endsWith(clause.field, clause.text);
    case 'ieq':
      return iEq(clause.field, clause.text);
    case 'regex':
      return regex(clause.field, clause.pattern, clause.flags);
  }
}

function parseFilterKey(
  key: string,
  extensions: ReadonlySet<string>,
): { field: string; op: string; explicit: boolean } {
  if (key.length > MAX_KEY_LENGTH) {
    throw new QueryGrammarError(
      key.slice(0, 64),
      `key longer than ${MAX_KEY_LENGTH} characters`,
      'syntax',
    );
  }
  const match = FILTER_KEY_RE.exec(key);
  if (!match) {
    if (key.includes('$')) {
      throw new QueryGrammarError(key, '`$` operators are not part of the query grammar', 'syntax');
    }
    const nested = /^([^[\]]+)\[([^[\]]+)\]\[/.exec(key);
    if (nested) {
      throw new QueryGrammarError(
        key,
        `a nested field is a dot path: ${nested[1]}.${nested[2]}`,
        'syntax',
      );
    }
    throw new QueryGrammarError(
      key,
      'not a valid filter key (`field` or `field[operator]`)',
      'syntax',
    );
  }
  const field = match[1] as string;
  const op = match[2] ?? 'eq';
  if (!(op in URL_OPERATOR_SET) && !extensions.has(op)) {
    throw new QueryGrammarError(
      key,
      `unknown operator "${op}" (supported: ${[...URL_OPERATORS, ...extensions].join(', ')}); ` +
        `a nested field is a dot path: ${field}.${op}`,
      'syntax',
    );
  }
  return { field, op, explicit: match[2] !== undefined };
}

function toClauses(
  param: string,
  field: string,
  op: string,
  raw: string,
  fieldType: QueryFieldType | undefined,
  maxText: number,
): FilterClause[] {
  switch (op) {
    case 'eq':
    case 'ne':
      return [{ field, op, value: coerceQueryValue(raw, { fieldType, param }) }];
    case 'gt':
    case 'gte':
    case 'lt':
    case 'lte':
      return [{ field, op, value: rangeValue(raw, fieldType, param) }];
    case 'in':
    case 'nin': {
      const values = splitList(raw).map((item) => coerceQueryValue(item, { fieldType, param }));
      return values.length > 0 ? [{ field, op, values }] : [];
    }
    case 'between': {
      const parts = raw.split(',').map((part) => part.trim());
      if (parts.length !== 2 || (parts[0] === '' && parts[1] === '')) {
        throw new QueryGrammarError(param, 'between takes `from,to` (one side may be empty)');
      }
      const [from, to] = parts as [string, string];
      const out: FilterClause[] = [];
      if (from !== '') out.push({ field, op: 'gte', value: rangeValue(from, fieldType, param) });
      if (to !== '') out.push({ field, op: 'lte', value: rangeValue(to, fieldType, param) });
      return out;
    }
    case 'exists': {
      const lower = raw.toLowerCase();
      if (lower === 'true' || lower === '1') return [{ field, op: 'exists', value: true }];
      if (lower === 'false' || lower === '0') return [{ field, op: 'exists', value: false }];
      throw new QueryGrammarError(param, 'exists takes true or false');
    }
    case 'like':
    case 'contains':
    case 'startsWith':
    case 'endsWith':
    case 'ieq': {
      if (raw.length > maxText) {
        throw new QueryGrammarError(param, `text longer than ${maxText} characters`);
      }
      return [{ field, op: op === 'like' ? 'contains' : op, text: raw }];
    }
    case 'regex': {
      const risk = assessRegex(raw, { maxLength: maxText });
      if (!risk.safe) throw new QueryGrammarError(param, `regex refused (${risk.reason})`);
      return [{ field, op: 'regex', pattern: raw }];
    }
  }
  throw new QueryGrammarError(param, `unknown operator "${op}"`, 'syntax');
}

function rangeValue(
  raw: string,
  fieldType: QueryFieldType | undefined,
  param: string,
): QueryScalar {
  const value = coerceQueryValue(raw, { fieldType, range: true, param });
  if (value === null) throw new QueryGrammarError(param, 'a range bound cannot be null');
  return value;
}

function splitList(raw: string): string[] {
  return raw
    .split(',')
    .map((item) => item.trim())
    .filter((item) => item !== '');
}

/**
 * Membership on one field is a UNION, never an AND of alternatives: `status=a&status=b`,
 * `status[in]=a&status[in]=b` and `status=a&status[in]=b,c` are one `in`; the `ne`/`nin`
 * family likewise becomes one `nin`. Ranges and text clauses on a field still AND.
 */
function collapseRepeats(clauses: FilterClause[]): FilterClause[] {
  const family = (c: FilterClause): 'in' | 'nin' | undefined =>
    c.op === 'eq' || c.op === 'in' ? 'in' : c.op === 'ne' || c.op === 'nin' ? 'nin' : undefined;
  const valuesOf = (c: FilterClause): readonly QueryScalar[] =>
    c.op === 'in' || c.op === 'nin' ? c.values : [(c as { value: QueryScalar }).value];
  const key = (c: FilterClause): string => `${family(c)}:${c.field}`;

  const groups = new Map<string, FilterClause[]>();
  for (const clause of clauses) {
    if (family(clause) === undefined) continue;
    groups.set(key(clause), [...(groups.get(key(clause)) ?? []), clause]);
  }

  const out: FilterClause[] = [];
  const emitted = new Set<string>();
  for (const clause of clauses) {
    const group = family(clause) === undefined ? undefined : groups.get(key(clause));
    if (group === undefined || group.length === 1) {
      out.push(clause);
    } else if (!emitted.has(key(clause))) {
      emitted.add(key(clause));
      const values = [...new Set(group.flatMap(valuesOf))];
      out.push({ field: clause.field, op: family(clause) as 'in' | 'nin', values });
    }
  }
  return out;
}

// ──────────────────────────────────────────────────────────────────────
// Paging, sort, select, search
// ──────────────────────────────────────────────────────────────────────

export interface PageRequest {
  readonly limit: number;
  /** Offset page (1-based). Absent on a keyset request — `after` wins over `page`. */
  readonly page?: number;
  /** Keyset cursor (`after`, or its alias `cursor`). */
  readonly after?: string;
}

export interface PageOptions {
  defaultLimit?: number | undefined;
  maxLimit?: number | undefined;
}

/** `limit`/`page` must be positive integers; a `limit` above the cap is clamped to it. */
export function readPageRequest(
  input: { page?: unknown; limit?: unknown; after?: unknown; cursor?: unknown },
  options: PageOptions = {},
): PageRequest {
  const maxLimit = options.maxLimit ?? DEFAULT_MAX_LIMIT;
  const requested = positiveInt(input.limit, 'limit');
  const limit = Math.min(requested ?? options.defaultLimit ?? DEFAULT_LIMIT, maxLimit);
  const after = cursorValue(input.after ?? input.cursor);
  if (after !== undefined) return { limit, after };
  const page = positiveInt(input.page, 'page');
  return page === undefined ? { limit } : { limit, page };
}

/** `sort=-createdAt,name` or qs `sort[createdAt]=desc`. An invalid or disallowed field is refused. */
export function readSort(
  raw: unknown,
  options: {
    allowedSortFields?: readonly string[] | undefined;
    /** Drop mode: called for each refused token, which is skipped. */
    onInvalid?: ((error: QueryGrammarError) => void) | undefined;
  } = {},
): ParsedSort | undefined {
  if (raw === undefined || raw === null || raw === '') return undefined;
  const allowed = options.allowedSortFields ? new Set(options.allowedSortFields) : undefined;
  const sort: ParsedSort = {};
  const refuse = (param: string, reason: string, kind: QueryErrorKind = 'syntax'): void => {
    const error = new QueryGrammarError(param, reason, kind);
    if (!options.onInvalid) throw error;
    options.onInvalid(error);
  };
  const add = (field: string, direction: 1 | -1): void => {
    if (allowed && !allowed.has(field))
      refuse('sort', `"${field}" is not a sortable field`, 'policy');
    else sort[field] = direction;
  };

  if (isPlainObject(raw)) {
    for (const [field, value] of Object.entries(raw)) {
      const dir = String(value).toLowerCase();
      if (!FIELD_RE.test(field)) refuse('sort', `"${field}" is not a field`);
      else if (dir === 'asc' || dir === '1') add(field, 1);
      else if (dir === 'desc' || dir === '-1') add(field, -1);
      else refuse(`sort[${field}]`, 'direction is asc or desc', 'value');
    }
  } else {
    const tokens = (Array.isArray(raw) ? raw : [raw]).flatMap(splitTokens);
    for (const token of tokens.map((t) => t.trim()).filter((t) => t !== '')) {
      const match = SORT_TOKEN_RE.exec(token);
      if (!match) refuse('sort', `"${token}" is not a field`);
      else add(match[2] as string, match[1] === '-' ? -1 : 1);
    }
  }
  return Object.keys(sort).length > 0 ? sort : undefined;
}

/** `select=name,-password`, or a `{ field: 0 | 1 }` projection. An invalid entry is refused. */
export function readSelect(
  raw: unknown,
  options: { onInvalid?: ((error: QueryGrammarError) => void) | undefined } = {},
): ParsedSelect | undefined {
  if (raw === undefined || raw === null || raw === '') return undefined;
  const select: ParsedSelect = {};
  const refuse = (param: string, reason: string, kind: QueryErrorKind): void => {
    const error = new QueryGrammarError(param, reason, kind);
    if (!options.onInvalid) throw error;
    options.onInvalid(error);
  };
  if (isPlainObject(raw)) {
    for (const [field, flag] of Object.entries(raw)) {
      const value = String(flag);
      if (!FIELD_RE.test(field)) refuse('select', `"${field}" is not a field`, 'syntax');
      else if (value !== '0' && value !== '1') {
        refuse(`select[${field}]`, 'a projection flag is 0 or 1', 'value');
      } else select[field] = value === '1' ? 1 : 0;
    }
  } else {
    const tokens = (Array.isArray(raw) ? raw : [raw]).flatMap(splitTokens);
    for (const token of tokens.map((t) => t.trim()).filter((t) => t !== '')) {
      const match = SELECT_TOKEN_RE.exec(token);
      if (!match) refuse('select', `"${token}" is not a field`, 'syntax');
      else select[match[2] as string] = match[1] === '-' ? 0 : 1;
    }
  }
  return Object.keys(select).length > 0 ? select : undefined;
}

/** Free-text search; longer than the cap is refused, never silently truncated. */
export function readSearch(
  raw: unknown,
  options: { maxSearchLength?: number | undefined } = {},
): string | undefined {
  if (raw === undefined || raw === null) return undefined;
  const search = String(raw).trim();
  if (search === '') return undefined;
  const max = options.maxSearchLength ?? DEFAULT_MAX_SEARCH_LENGTH;
  if (search.length > max) throw new QueryGrammarError('search', `longer than ${max} characters`);
  return search;
}

// ──────────────────────────────────────────────────────────────────────
// Input normalization
// ──────────────────────────────────────────────────────────────────────

/** Every input shape → one record: repeated URL keys become arrays, qs objects stay nested. */
export function toRecord(input: QueryInput | null | undefined): Record<string, unknown> {
  if (input === null || input === undefined) return {};
  if (input instanceof URLSearchParams || isEntryIterable(input)) {
    const record: Record<string, unknown> = {};
    const entries = input instanceof URLSearchParams ? input.entries() : input;
    for (const [key, value] of entries) {
      const prev = record[key];
      record[key] =
        prev === undefined ? value : Array.isArray(prev) ? [...prev, value] : [prev, value];
    }
    return record;
  }
  return input as Record<string, unknown>;
}

function isEntryIterable(input: unknown): input is Iterable<readonly [string, string]> {
  return (
    typeof input === 'object' &&
    input !== null &&
    !(input instanceof URLSearchParams) &&
    Symbol.iterator in input
  );
}

/** Flat `[bracketKey, scalar]` pairs for every non-reserved param, unwrapping the `filter` envelope. */
function* filterEntries(
  record: Record<string, unknown>,
  reserved: ReadonlySet<string>,
): Generator<[string, unknown]> {
  for (const [key, value] of Object.entries(record)) {
    const top = key.split('[', 1)[0] as string;
    if (top === 'filter') {
      if (key === 'filter') {
        if (!isPlainObject(value)) {
          yield ['filter', new Refusal('the envelope is filter[field]=value')];
          continue;
        }
        for (const [inner, innerValue] of Object.entries(value)) {
          yield* flatten(inner, innerValue, 1);
        }
      } else {
        yield* flatten(key.replace(/^filter\[([^\]]*)\]/, '$1'), value, 1);
      }
      continue;
    }
    if (reserved.has(top)) continue;
    yield* flatten(key, value, 0);
  }
}

/** Refuses input nested past {@link MAX_NESTING} BEFORE recursing into it. */
function* flatten(path: string, value: unknown, depth: number): Generator<[string, unknown]> {
  if (value === undefined) return;
  if (depth > MAX_NESTING) {
    yield [path.slice(0, 64), new Refusal('nested too deeply')];
    return;
  }
  if (Array.isArray(value)) {
    for (const item of value) yield* flatten(path, item, depth + 1);
    return;
  }
  if (isPlainObject(value)) {
    for (const [key, inner] of Object.entries(value)) {
      yield* flatten(`${path}[${key}]`, inner, depth + 1);
    }
    return;
  }
  yield [path, value];
}

/**
 * A refusal found while flattening, yielded in place of a value so the caller's `onInvalid` policy
 * applies to it like any other entry — a generator that threw would end the whole read.
 */
class Refusal {
  constructor(readonly reason: string) {}
}

/** Sort/select tokens: comma- or whitespace-separated (`a,-b` or Mongoose's `a -b`). */
function splitTokens(part: unknown): string[] {
  return String(part).split(/[\s,]+/);
}

function toRaw(key: string, value: unknown): string {
  if (value instanceof Refusal) throw new QueryGrammarError(key, value.reason, 'syntax');
  if (value === null) return 'null';
  if (value instanceof Date) return value.toISOString();
  if (typeof value === 'string') return value;
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  throw new QueryGrammarError(key, 'a filter value is a string', 'syntax');
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return (
    typeof value === 'object' && value !== null && Object.getPrototypeOf(value) === Object.prototype
  );
}

function positiveInt(raw: unknown, param: 'page' | 'limit'): number | undefined {
  if (raw === undefined || raw === null || raw === '') return undefined;
  const value =
    typeof raw === 'number'
      ? raw
      : /^\d+$/.test(String(raw).trim())
        ? Number(String(raw).trim())
        : Number.NaN;
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new QueryGrammarError(param, `"${String(raw)}" is not a positive integer`);
  }
  return value;
}

function cursorValue(raw: unknown): string | undefined {
  if (raw === undefined || raw === null) return undefined;
  const value = String(raw).trim();
  return value === '' ? undefined : value;
}
