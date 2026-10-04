/**
 * URL → {@link ParsedQuery} with a portable Filter IR. The grammar (keys, operators, coercion,
 * paging) is `./grammar.ts`'s; this adds only the IR emission and the populate spec.
 *
 *   ?status=active&age[gte]=18          → and(eq(status), gte(age, 18))
 *   ?role[in]=admin,editor              → in_(role, [...])
 *   ?name[contains]=john&sort=-createdAt → contains(name, 'john') + sort
 */

import { QueryGrammarError } from './errors.js';
import {
  clausesToFilter,
  DEFAULT_MAX_TEXT_LENGTH,
  type QueryInput,
  readFilterClauses,
  readPageRequest,
  readSearch,
  readSelect,
  readSort,
  toRecord,
} from './grammar.js';
import type { ParsedPopulate, ParsedQuery, QueryParserInput, QueryParserOptions } from './types.js';

const FIELD_RE = /^[A-Za-z_][A-Za-z0-9_]*(?:\.[A-Za-z0-9_]+)*$/;

/** Parse URL search params into a driver-agnostic ParsedQuery. Invalid input throws a 400. */
export function parseUrl(input: QueryParserInput, options: QueryParserOptions = {}): ParsedQuery {
  const record = toRecord(input as QueryInput);
  const pageRequest = readPageRequest(
    { page: first(record['page']), limit: first(record['limit']), after: first(record['after']) },
    { defaultLimit: options.defaultLimit, maxLimit: options.maxLimit },
  );
  const { clauses } = readFilterClauses(record, {
    allowedFilterFields: options.allowedFilterFields,
    allowedOperators: options.allowedOperators,
    fieldTypes: options.fieldTypes,
    maxTextLength: options.maxRegexLength ?? DEFAULT_MAX_TEXT_LENGTH,
  });

  const result: ParsedQuery = { filter: clausesToFilter(clauses), limit: pageRequest.limit };
  const sort = readSort(record['sort'], { allowedSortFields: options.allowedSortFields });
  if (sort) result.sort = sort;
  const select = readSelect(record['select']);
  if (select) result.select = select;
  const populate = readPopulate(record);
  if (populate.length > 0) result.populate = populate;
  if (pageRequest.page !== undefined) result.page = pageRequest.page;
  if (pageRequest.after !== undefined) result.after = pageRequest.after;
  const search = readSearch(first(record['search']), { maxSearchLength: options.maxSearchLength });
  if (search !== undefined) result.search = search;
  return result;
}

/** A repeated control param (`?limit=5&limit=9`) is ambiguous — refused rather than guessed. */
function first(value: unknown): unknown {
  if (!Array.isArray(value)) return value;
  if (value.length > 1) throw new QueryGrammarError('query', 'a control parameter is repeated');
  return value[0];
}

/**
 * `populate[path][select]=a,b` and `populate[path][match][field]=value` (field equality only —
 * a `$` key or a nested condition is refused, never passed to the kit).
 */
function readPopulate(record: Record<string, unknown>): ParsedPopulate[] {
  const byPath = new Map<string, ParsedPopulate>();
  const entry = (path: string): ParsedPopulate => {
    if (!FIELD_RE.test(path))
      throw new QueryGrammarError(`populate[${path}]`, 'not a field path', 'syntax');
    const existing = byPath.get(path) ?? { path };
    byPath.set(path, existing);
    return existing;
  };

  for (const [key, value] of Object.entries(record)) {
    if (
      key === 'populate' &&
      value !== null &&
      typeof value === 'object' &&
      !Array.isArray(value)
    ) {
      for (const [path, spec] of Object.entries(value as Record<string, unknown>)) {
        const target = entry(path);
        if (spec === null || typeof spec !== 'object' || Array.isArray(spec)) continue;
        const { select, match } = spec as { select?: unknown; match?: unknown };
        if (typeof select === 'string') target.select = select;
        if (match !== undefined) target.match = readMatch(path, match);
      }
      continue;
    }
    const flat = /^populate\[([^\]]+)\](?:\[(select|match)\](?:\[([^\]]+)\])?)?$/.exec(key);
    if (!flat) continue;
    const [, path, sub, matchField] = flat as unknown as [string, string, string?, string?];
    const target = entry(path);
    if (sub === 'select') target.select = String(value);
    if (sub === 'match' && matchField) {
      target.match = { ...target.match, ...readMatch(path, { [matchField]: value }) };
    }
  }
  return [...byPath.values()];
}

function readMatch(path: string, match: unknown): Record<string, unknown> {
  if (match === null || typeof match !== 'object' || Array.isArray(match)) {
    throw new QueryGrammarError(
      `populate[${path}][match]`,
      'use populate[path][match][field]=value',
      'syntax',
    );
  }
  for (const [field, value] of Object.entries(match as Record<string, unknown>)) {
    if (!FIELD_RE.test(field) || (value !== null && typeof value === 'object')) {
      throw new QueryGrammarError(
        `populate[${path}][match]`,
        `field equality only: "${field}"`,
        'syntax',
      );
    }
  }
  return match as Record<string, unknown>;
}
