/**
 * Public entry for the `query-parser` subpath.
 *
 * One parser, one output shape (`ParsedQuery`), consumed identically by
 * every kit. Frontends (arc-next, fluid) import the types from here too,
 * so URL bracket grammar stays aligned end-to-end.
 */

export { coerceList, coerceValue } from './coerce.js';
export { parseUrl } from './parse-url.js';
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
