/**
 * URL value → typed scalar. A declared field type wins, and a value that does not fit it is
 * refused. Without one, a conservative heuristic applies: never a leading-zero code (`007`), never a
 * digit string long enough to be an id or to lose precision, and a date only for a RANGE operand —
 * `?code=2026-01-01` is a string far more often than a date.
 */

import { ISO_DATE_PATTERN } from '../filter/coerce-dates.js';
import { QueryGrammarError } from './errors.js';

/** Field types a caller (or a kit, from its schema) can declare for exact coercion. */
export type QueryFieldType = 'string' | 'number' | 'boolean' | 'date';

/** What a URL value coerces to. */
export type QueryScalar = string | number | boolean | Date | null;

const HEURISTIC_NUMBER = /^-?(?:0|[1-9]\d*)(?:\.\d+)?$/;
const MAX_HEURISTIC_NUMBER_LENGTH = 15;
const STRICT_NUMBER = /^-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?$/;

export interface CoerceOptions {
  /** The field's declared type, when known. */
  fieldType?: QueryFieldType | undefined;
  /** True for a range operand (`gt`/`gte`/`lt`/`lte`/`between`) — enables date detection. */
  range?: boolean;
  /** The parameter, for the error message. */
  param: string;
}

export function coerceQueryValue(raw: string, options: CoerceOptions): QueryScalar {
  if (raw === 'null') return null;
  const { fieldType, param } = options;

  switch (fieldType) {
    case 'string':
      return raw;
    case 'number': {
      if (!STRICT_NUMBER.test(raw)) throw new QueryGrammarError(param, `"${raw}" is not a number`);
      return Number(raw);
    }
    case 'boolean': {
      const lower = raw.toLowerCase();
      if (lower === 'true' || lower === '1') return true;
      if (lower === 'false' || lower === '0') return false;
      throw new QueryGrammarError(param, `"${raw}" is not a boolean (true/false)`);
    }
    case 'date':
      return toDate(raw) ?? fail(param, `"${raw}" is not an ISO-8601 date`);
  }

  if (raw === 'true') return true;
  if (raw === 'false') return false;
  if (options.range) {
    const date = toDate(raw);
    if (date) return date;
    // A range bound is a magnitude, never an id — any finite number shape is numeric.
    if (STRICT_NUMBER.test(raw) && Number.isFinite(Number(raw))) return Number(raw);
  }
  if (raw.length <= MAX_HEURISTIC_NUMBER_LENGTH && HEURISTIC_NUMBER.test(raw)) return Number(raw);
  return raw;
}

function toDate(raw: string): Date | undefined {
  if (!ISO_DATE_PATTERN.test(raw)) return undefined;
  const date = new Date(raw);
  return Number.isNaN(date.getTime()) ? undefined : date;
}

function fail(param: string, reason: string): never {
  throw new QueryGrammarError(param, reason);
}
