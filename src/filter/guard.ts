/**
 * Runtime predicates for Filter IR.
 *
 * Kits use `isFilter` to distinguish IR values from raw kit-native filter
 * records (mongokit's `$`-keyed objects, Prisma's `WhereInput` shapes) so
 * the compiler can route each to the right handler. IR inputs get
 * compiled; raw records roundtrip unchanged.
 */

import type { Filter, FilterOp } from './types.js';

const FILTER_OPS: ReadonlySet<FilterOp> = new Set([
  'eq',
  'ne',
  'gt',
  'gte',
  'lt',
  'lte',
  'in',
  'nin',
  'like',
  'regex',
  'exists',
  'and',
  'or',
  'not',
  'true',
  'false',
  'raw',
]);

/**
 * True when `value` is a Filter IR node.
 *
 * Structural check: requires `op` to be a known filter operator string.
 * Deeper validation (children are themselves filters, field is a string,
 * values is an array) is left to the compiler — this is the fast-path gate.
 */
export function isFilter(value: unknown): value is Filter {
  if (!value || typeof value !== 'object') return false;
  const op = (value as { op?: unknown }).op;
  return typeof op === 'string' && FILTER_OPS.has(op as FilterOp);
}
