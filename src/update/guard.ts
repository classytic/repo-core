/**
 * Runtime predicates for Update IR.
 *
 * Kits use `isUpdateSpec` in their `findOneAndUpdate` / `updateMany`
 * implementations to distinguish an IR spec from a raw kit-native record
 * (mongokit `$`-ops, Prisma `update` input) or a Mongo aggregation
 * pipeline. Dispatch is structural — the compiler routes each form to the
 * right handler.
 */

import type { UpdateSpec } from './types.js';

/**
 * True when `value` is an `UpdateSpec` — i.e. the portable, compile-to-native
 * form.
 *
 * Fast structural gate: checks the discriminant tag. Deeper validation (no
 * `$`-prefixed keys inside `set`, `inc` values are numbers, ...) is left
 * to the compiler; that's where kit-specific constraints live.
 */
export function isUpdateSpec(value: unknown): value is UpdateSpec {
  if (!value || typeof value !== 'object') return false;
  if (Array.isArray(value)) return false;
  return (value as { op?: unknown }).op === 'update';
}

/**
 * True when `value` is a Mongo aggregation pipeline (`findOneAndUpdate`'s
 * array form). Kits use this to short-circuit SQL paths that can't execute
 * pipelines.
 */
export function isUpdatePipeline(value: unknown): value is Record<string, unknown>[] {
  return Array.isArray(value);
}
