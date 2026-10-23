/**
 * Typed filters -> the URL params {@link parseUrl} accepts: the inverse of the grammar in
 * `./grammar.ts`, client-safe, built from the same operator constants.
 *
 *   formatQuery({ filters: [{ field: 'age', op: 'gte', value: 18 }], sort: '-createdAt' })
 *     -> { 'age[gte]': '18', sort: '-createdAt' }
 *
 * An empty value (`''`, `undefined`, `[]`) is no filter, as the parser reads it. `between` is sent
 * as `gte` + `lte`. A value the grammar cannot carry is refused, never sent mangled.
 */

import { QueryGrammarError } from './errors.js';
import { URL_OPERATORS } from './grammar.js';
import type { BracketOperator } from './types.js';

/** Operators a filter term can use: every URL operator except `options` (regex flags ride on `flags`). */
export type FilterOperator = Exclude<BracketOperator, 'options'>;

/** One typed filter. `op` defaults to `eq`. */
export interface FilterTerm {
  field: string;
  op?: FilterOperator;
  /**
   * `in`/`nin`: array. `between`: `[from, to]` (either side may be empty). `exists`: boolean.
   * Otherwise a string, number, boolean, `Date` or `null`.
   */
  value?: unknown;
  /** `regex` only: flags from `i`, `m`, `s`, `x`. */
  flags?: string;
}

export interface FormatQueryInput {
  filters?: readonly FilterTerm[];
  /** `'-createdAt'`, `'name'` or a list of them. */
  sort?: string | readonly string[];
  page?: number;
  limit?: number;
  /** Free-text search, trimmed; empty is omitted. */
  search?: string;
}

/** Flat params in the shape `parseUrl` takes and Fastify/qs produce. */
export type QueryParams = Record<string, string>;

const FIELD_RE = /^[A-Za-z_][A-Za-z0-9_-]*(?:\.[A-Za-z0-9_-]+)*$/;

export function formatQuery(input: FormatQueryInput): QueryParams {
  const out: QueryParams = {};
  const put = (key: string, value: string): void => {
    if (key in out)
      throw new QueryGrammarError(key, 'sent twice (one term per field and operator)', 'syntax');
    out[key] = value;
  };
  for (const term of input.filters ?? []) writeTerm(term, put);
  if (input.sort !== undefined) {
    const sort = (Array.isArray(input.sort) ? input.sort : [input.sort]).join(',');
    if (sort) out['sort'] = sort;
  }
  if (input.page !== undefined) out['page'] = positive('page', input.page);
  if (input.limit !== undefined) out['limit'] = positive('limit', input.limit);
  const search = input.search?.trim();
  if (search) out['search'] = search;
  return out;
}

/** {@link formatQuery} as a query string, without the leading `?`. */
export function stringifyQuery(input: FormatQueryInput): string {
  return new URLSearchParams(formatQuery(input)).toString();
}

function writeTerm(term: FilterTerm, put: (key: string, value: string) => void): void {
  const { field, value } = term;
  const op = term.op ?? 'eq';
  if (!FIELD_RE.test(field)) throw new QueryGrammarError(field, 'not a field path', 'syntax');
  if (!(URL_OPERATORS as readonly string[]).includes(op) || (op as string) === 'options') {
    throw new QueryGrammarError(field, `unknown operator "${String(op)}"`, 'syntax');
  }
  const key = (o: string): string => (o === 'eq' ? field : `${field}[${o}]`);
  if (value === undefined || value === '' || (Array.isArray(value) && value.length === 0)) return;

  switch (op) {
    case 'in':
    case 'nin': {
      if (!Array.isArray(value)) throw new QueryGrammarError(key(op), `${op} takes an array`);
      const items = value.map((v) => scalar(v, key(op)));
      if (items.some((item) => item.includes(','))) {
        throw new QueryGrammarError(key(op), 'a list value cannot contain a comma');
      }
      put(key(op), items.join(','));
      return;
    }
    case 'between': {
      if (!Array.isArray(value) || value.length !== 2) {
        throw new QueryGrammarError(key(op), 'between takes [from, to]');
      }
      const [from, to] = value as [unknown, unknown];
      if (from !== undefined && from !== '' && from !== null)
        put(key('gte'), scalar(from, key('gte')));
      if (to !== undefined && to !== '' && to !== null) put(key('lte'), scalar(to, key('lte')));
      return;
    }
    case 'exists':
      if (typeof value !== 'boolean')
        throw new QueryGrammarError(key(op), 'exists takes a boolean');
      {
        put(key(op), String(value));
        return;
      }
    default:
      put(key(op), scalar(value, key(op)));
      if (op === 'regex' && term.flags) {
        if (!/^[imsx]+$/.test(term.flags))
          throw new QueryGrammarError(`${field}[options]`, 'flags must be from i, m, s, x');
        put(`${field}[options]`, term.flags);
      }
  }
}

function scalar(value: unknown, param: string): string {
  if (value === null) return 'null';
  if (value instanceof Date) {
    if (Number.isNaN(value.getTime())) throw new QueryGrammarError(param, 'invalid Date');
    return value.toISOString();
  }
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new QueryGrammarError(param, 'not a finite number');
    return String(value);
  }
  if (typeof value === 'boolean') return String(value);
  if (typeof value !== 'string') {
    throw new QueryGrammarError(param, 'a filter value is a string, number, boolean, Date or null');
  }
  if (value === 'null') throw new QueryGrammarError(param, 'the text "null" reads as null');
  return value;
}

function positive(param: 'page' | 'limit', value: number): string {
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new QueryGrammarError(param, `"${String(value)}" is not a positive integer`);
  }
  return String(value);
}
