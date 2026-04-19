/**
 * Public entry for the `filter` subpath.
 *
 * The Filter IR is the most important single primitive in repo-core. It is
 * the lingua franca that lets policy plugins (multi-tenant, soft-delete)
 * compose filter nodes once and have every kit compile them to native
 * syntax — Mongo `$`-ops, SQL `WHERE`, Prisma `WhereInput`.
 */

export {
  and,
  anyOf,
  between,
  contains,
  endsWith,
  eq,
  exists,
  FALSE,
  gt,
  gte,
  iEq,
  in_,
  invert,
  isNotNull,
  isNull,
  like,
  lt,
  lte,
  ne,
  nin,
  noneOf,
  not,
  or,
  raw,
  regex,
  startsWith,
  TRUE,
} from './builders.js';
export { isFilter } from './guard.js';
export { asPredicate, matchFilter } from './match.js';
export { buildTenantScope, mergeScope, SCOPE_ANY } from './scope.js';
export type {
  Filter,
  FilterAnd,
  FilterEq,
  FilterExists,
  FilterFalse,
  FilterGt,
  FilterGte,
  FilterIn,
  FilterLike,
  FilterLt,
  FilterLte,
  FilterNe,
  FilterNin,
  FilterNot,
  FilterOp,
  FilterOr,
  FilterRaw,
  FilterRegex,
  FilterTrue,
} from './types.js';
export { collectFields, mapFilter, walkFilter } from './walk.js';
