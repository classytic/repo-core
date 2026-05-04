/**
 * Canonical option keys forwarded into every `MinimalRepo` /
 * `StandardRepo` method call.
 *
 * The options bag is the cross-cutting plumbing every kit's plugin
 * layer reads from: multi-tenant scope, audit attribution, transaction
 * threading, observability correlation. Hosts (and arc-style
 * frameworks) extract these from the request context once and forward
 * them into every repo call so plugins don't need request-context
 * access of their own.
 *
 * Without a single agreed-on set, drift is inevitable: one host
 * forwards `userId`, another forwards `actorId`, a third forgets
 * `requestId` entirely — and audit logs lose attribution silently.
 * `STANDARD_REPO_OPTION_KEYS` is the contract every kit and every
 * arc-style framework agrees on. Adding a key here is a deliberate
 * ecosystem-wide commitment.
 *
 * Kits implementing custom plugins (commission, supplier-performance,
 * pos, ...) can declare their own canonical sets via mongokit's
 * `createOptionsExtractor<TCtx>` — that pattern stays domain-local and
 * doesn't pollute the cross-kit contract.
 */

/**
 * The canonical keys every kit's plugin layer reads from the options
 * bag, and every framework auto-threads from request context.
 *
 * - `organizationId` — multi-tenant scope. Tenant plugins
 *   (mongokit's `multiTenantPlugin`, sqlitekit's tenant filter) read
 *   it to stamp on write + filter on read. Cast handling (e.g.
 *   `ObjectId` coercion) is plugin-local — pass the raw scope id.
 * - `userId` — actor id for audit attribution. Audit-log / audit-
 *   trail plugins read it for the `who` column.
 * - `user` — denormalized actor object, when the audit log wants
 *   richer payload than a bare id (display name, role snapshot, ...).
 * - `session` — driver-specific transaction handle. Mongoose
 *   `ClientSession`, better-sqlite3 transaction fn, Prisma
 *   transaction client. Opaque to repo-core — kits narrow at the
 *   boundary.
 * - `requestId` — request correlation id for trace stitching across
 *   logs, events, and downstream service calls.
 *
 * Frameworks should treat this set as the canonical forward list:
 * peel matching keys off the request context, drop them into the
 * options bag, and let kit plugins read what they implement. Unknown
 * ctx keys do NOT forward — the bag stays narrow.
 */
export const STANDARD_REPO_OPTION_KEYS = [
  'organizationId',
  'userId',
  'user',
  'session',
  'requestId',
] as const;

/**
 * Type-level union of canonical option keys. Use to constrain
 * framework helpers that thread request context into repo options:
 *
 * ```ts
 * function pickStandardOptions(ctx: Record<string, unknown>): Partial<
 *   Record<StandardRepoOptionKey, unknown>
 * > { ... }
 * ```
 */
export type StandardRepoOptionKey = (typeof STANDARD_REPO_OPTION_KEYS)[number];
