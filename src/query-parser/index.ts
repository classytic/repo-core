/**
 * Public entry for the `query-parser` subpath.
 *
 * One parser, one output shape (`ParsedQuery`), consumed identically by
 * every kit. Frontends (arc-next, fluid) import the types from here too,
 * so URL bracket grammar stays aligned end-to-end.
 */

export {
  type CoerceOptions,
  coerceQueryValue,
  type QueryFieldType,
  type QueryScalar,
} from './coerce.js';
export {
  INVALID_QUERY_INPUT,
  isQueryGrammarError,
  type QueryErrorKind,
  QueryGrammarError,
} from './errors.js';
export {
  CORE_OPERATORS,
  type CoreOperator,
  clausesToFilter,
  DEFAULT_LIMIT,
  DEFAULT_MAX_LIMIT,
  DEFAULT_MAX_SEARCH_LENGTH,
  DEFAULT_MAX_TEXT_LENGTH,
  type ExtensionClause,
  type FilterClause,
  type FilterReadResult,
  OPERATOR_DESCRIPTIONS,
  type PageOptions,
  type PageRequest,
  type QueryGrammarOptions,
  type QueryInput,
  readFilterClauses,
  readPageRequest,
  readSearch,
  readSelect,
  readSort,
  toRecord,
  URL_OPERATORS,
} from './grammar.js';
export { parseUrl } from './parse-url.js';
export {
  assessRegex,
  escapeRegex,
  MAX_UNBOUNDED_QUANTIFIERS,
  type RegexRisk,
} from './regex-safety.js';
export { isControlParam, STANDARD_RESERVED_PARAMS } from './reserved.js';
export type {
  BracketOperator,
  ParsedPopulate,
  ParsedQuery,
  ParsedSelect,
  ParsedSort,
  ParsedSortDirection,
  QueryParserInput,
  QueryParserOptions,
} from './types.js';
