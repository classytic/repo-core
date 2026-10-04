import type { HttpError, ValidationErrorMeta } from '../errors/types.js';

/** The code every query-grammar refusal carries — stable across parsers and kits. */
export const INVALID_QUERY_INPUT = 'INVALID_QUERY_INPUT';

/**
 * What kind of input was refused — so a lenient parser can relax one kind without the others:
 * - `syntax`: not query grammar at all (a `$` key, an unknown operator, malformed nesting) —
 *   an operator-smuggling attempt looks like this, so it is never worth tolerating.
 * - `policy`: well-formed but outside an allowlist (a field, operator or sort field).
 * - `value`: a value that does not fit (a type, a bound, an unsafe regex, a length).
 */
export type QueryErrorKind = 'syntax' | 'policy' | 'value';

/**
 * A list query the grammar refuses (400). `validationErrors[0].path` names the offending
 * parameter, so a client can attach the message to the filter control that produced it.
 */
export class QueryGrammarError extends Error implements HttpError {
  readonly status = 400;
  readonly code = INVALID_QUERY_INPUT;
  readonly meta: { readonly param: string; readonly reason: string; readonly kind: QueryErrorKind };
  readonly validationErrors: ValidationErrorMeta[];

  constructor(param: string, reason: string, kind: QueryErrorKind = 'value') {
    super(`Invalid query parameter "${param}": ${reason}`);
    this.name = 'QueryGrammarError';
    this.meta = { param, reason, kind };
    this.validationErrors = [{ validator: 'query', error: reason, path: param }];
  }
}

export function isQueryGrammarError(value: unknown): value is QueryGrammarError {
  return value instanceof Error && (value as { code?: unknown }).code === INVALID_QUERY_INPUT;
}
