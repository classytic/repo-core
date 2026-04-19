/**
 * Canonical repository-operation event names.
 *
 * Every kit's repository emits these `before:* / after:* / error:*` events
 * via the hook engine. Plugin authors subscribe through `HOOK_EVENTS` so
 * typos become compile errors and a plugin written against these constants
 * works identically on mongokit, sqlitekit, pgkit, prismakit.
 *
 * ## Scope — the `MinimalRepo + StandardRepo` op set
 *
 * This constant covers **every op in repo-core's standard vocabulary.**
 * Kits with additional native operations (mongokit's `aggregate` / `bulkWrite`,
 * future pgkit's `copyFrom`, etc.) extend their own typed subset:
 *
 * ```ts
 * export const MONGOKIT_HOOK_EVENTS = {
 *   ...HOOK_EVENTS,
 *   BEFORE_AGGREGATE: 'before:aggregate',
 *   AFTER_AGGREGATE: 'after:aggregate',
 *   ERROR_AGGREGATE: 'error:aggregate',
 * } as const;
 * ```
 *
 * Subscribing to an event that a given kit doesn't emit is a no-op, not an
 * error — that's how the hook engine already behaves — so cross-kit plugins
 * can safely wire listeners for the full standard set and only fire on kits
 * that actually emit them.
 *
 * @example
 * ```ts
 * import { HOOK_EVENTS, HOOK_PRIORITY } from '@classytic/repo-core/hooks';
 *
 * repo.on(HOOK_EVENTS.BEFORE_CREATE, (ctx) => {
 *   if (!ctx.data?.organizationId) ctx.data = { ...ctx.data, organizationId: 'org_123' };
 * }, { priority: HOOK_PRIORITY.POLICY });
 * ```
 */

export const HOOK_EVENTS = {
  // ── MinimalRepo — every kit emits these ──────────────────────────────
  BEFORE_CREATE: 'before:create',
  AFTER_CREATE: 'after:create',
  ERROR_CREATE: 'error:create',

  BEFORE_UPDATE: 'before:update',
  AFTER_UPDATE: 'after:update',
  ERROR_UPDATE: 'error:update',

  BEFORE_DELETE: 'before:delete',
  AFTER_DELETE: 'after:delete',
  ERROR_DELETE: 'error:delete',

  BEFORE_GET_BY_ID: 'before:getById',
  AFTER_GET_BY_ID: 'after:getById',
  ERROR_GET_BY_ID: 'error:getById',

  BEFORE_GET_ALL: 'before:getAll',
  AFTER_GET_ALL: 'after:getAll',
  ERROR_GET_ALL: 'error:getAll',

  // ── StandardRepo — emitted by kits implementing the richer surface ──
  BEFORE_CREATE_MANY: 'before:createMany',
  AFTER_CREATE_MANY: 'after:createMany',
  ERROR_CREATE_MANY: 'error:createMany',

  BEFORE_UPDATE_MANY: 'before:updateMany',
  AFTER_UPDATE_MANY: 'after:updateMany',
  ERROR_UPDATE_MANY: 'error:updateMany',

  BEFORE_DELETE_MANY: 'before:deleteMany',
  AFTER_DELETE_MANY: 'after:deleteMany',
  ERROR_DELETE_MANY: 'error:deleteMany',

  BEFORE_FIND_ONE_AND_UPDATE: 'before:findOneAndUpdate',
  AFTER_FIND_ONE_AND_UPDATE: 'after:findOneAndUpdate',
  ERROR_FIND_ONE_AND_UPDATE: 'error:findOneAndUpdate',

  BEFORE_RESTORE: 'before:restore',
  AFTER_RESTORE: 'after:restore',
  ERROR_RESTORE: 'error:restore',

  BEFORE_GET_BY_QUERY: 'before:getByQuery',
  AFTER_GET_BY_QUERY: 'after:getByQuery',
  ERROR_GET_BY_QUERY: 'error:getByQuery',

  BEFORE_GET_ONE: 'before:getOne',
  AFTER_GET_ONE: 'after:getOne',
  ERROR_GET_ONE: 'error:getOne',

  BEFORE_FIND_ALL: 'before:findAll',
  AFTER_FIND_ALL: 'after:findAll',
  ERROR_FIND_ALL: 'error:findAll',

  BEFORE_GET_OR_CREATE: 'before:getOrCreate',
  AFTER_GET_OR_CREATE: 'after:getOrCreate',
  ERROR_GET_OR_CREATE: 'error:getOrCreate',

  BEFORE_COUNT: 'before:count',
  AFTER_COUNT: 'after:count',
  ERROR_COUNT: 'error:count',

  BEFORE_EXISTS: 'before:exists',
  AFTER_EXISTS: 'after:exists',
  ERROR_EXISTS: 'error:exists',

  BEFORE_DISTINCT: 'before:distinct',
  AFTER_DISTINCT: 'after:distinct',
  ERROR_DISTINCT: 'error:distinct',
} as const;

/** String-literal union of every canonical hook event name. */
export type HookEventName = (typeof HOOK_EVENTS)[keyof typeof HOOK_EVENTS];
