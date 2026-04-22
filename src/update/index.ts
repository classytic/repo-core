/**
 * Public entry for the `update` subpath.
 *
 * The Update IR is the write-side counterpart to the Filter IR. Plugins
 * compose `UpdateSpec` nodes once; each kit compiles them to `$set`/`$inc`
 * (Mongo), `SET col = ?` + `coalesce+` (SQL), or Prisma `update` input.
 *
 * Arc's stores (outbox, idempotency, audit) consume this so they can swap
 * between mongokit, sqlitekit, pgkit, and prismakit without rewriting the
 * atomic-update logic.
 */

export {
  combineUpdates,
  incFields,
  setFields,
  setOnInsertFields,
  unsetFields,
  update,
} from './builders.js';
export { compileUpdateSpecToMongo, compileUpdateSpecToSql, type SqlUpdatePlan } from './compile.js';
export { isUpdatePipeline, isUpdateSpec } from './guard.js';
export type { UpdateInput, UpdateSpec } from './types.js';
